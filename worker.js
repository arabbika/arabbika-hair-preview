// Cloudflare Worker - worker.js

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-access-pin", 
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

    try {
      // 1. Verify the PIN sent from the frontend against the Cloudflare Secret
      const clientPin = request.headers.get("x-access-pin");
      if (!env.APP_PIN || clientPin !== env.APP_PIN) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid PIN" }), { 
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const { clientImage, references, colour, clientName } = await request.json();

      if (!clientImage) {
        return new Response(JSON.stringify({ error: "Missing client image" }), { 
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const apiKey = env.XAI_API_KEY; 
      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API key not configured" }), { 
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const results = [];
      
      for (const ref of references.slice(0, 1)) {
        let promptText = "";
        let refImageUrl = null;
        const isCustomUpload = ref.startsWith('data:image');

        if (isCustomUpload) {
            refImageUrl = ref;
            promptText = `Edit the first image to change the person's hairstyle to match the hairstyle shown in the second image. The hair color must be ${colour}. Keep the person's face, skin tone, and identity exactly the same. Ensure the haircut looks natural and realistic.`;
        } else {
            promptText = `Edit this photo of a person. Change their hairstyle to a ${ref}. The hair must be ${colour}. Keep the person's face, skin tone, and background exactly the same. Ensure the haircut looks natural and realistic.`;
        }

        const payload = {
            model: "grok-imagine-image-2.0",
            prompt: promptText,
            images: [{ type: "image_url", url: clientImage }],
            response_format: "b64_json",
            aspect_ratio: "3:4",
            resolution: "1k"
        };

        if (refImageUrl) payload.images.push({ type: "image_url", url: refImageUrl });

        const xaiImageResponse = await fetch("https://api.x.ai/v1/images/edits", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!xaiImageResponse.ok) {
            console.error(`xAI Image Error:`, await xaiImageResponse.text());
            results.push({
                styleName: isCustomUpload ? "Custom Upload" : ref,
                refImage: ref,
                generatedImage: `https://via.placeholder.com/300x400?text=Error`,
                note: "Failed to generate image."
            });
            continue;
        }

        const imageDataRaw = await xaiImageResponse.json();
        const imageData = imageDataRaw.data?.[0]?.b64_json; 

        let stylistNote = "Preview generated successfully.";
        
        try {
            let notePromptUser = "";
            if (!isCustomUpload) {
                notePromptUser = `Hairstyle: ${ref}. Hair Colour: ${colour}.`;
            } else {
                notePromptUser = `Look at the reference hairstyle in the second image. Describe this hairstyle in a few words, then write a short, 2-sentence stylist note explaining how to cut and style this exact look for ${colour} hair. Focus on texture, light reflection, and maintenance.`;
            }

            const textResponse = await fetch("https://api.x.ai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "grok-3",
                    messages: [
                        { role: "system", content: "You are an expert hairstylist. Keep your response under 50 words." },
                        { 
                            role: "user", 
                            content: notePromptUser,
                            images: isCustomUpload ? [{ type: "image_url", url: ref }] : undefined
                        }
                    ],
                    temperature: 0.7
                })
            });
            
            const textData = await textResponse.json();
            if (textData.choices?.[0]?.message?.content) {
                stylistNote = textData.choices[0].message.content.trim();
            }
        } catch (e) {
            console.error("Stylist Note Error:", e);
            stylistNote = `A custom preview of a ${colour} hair look.`;
        }

        results.push({
            styleName: isCustomUpload ? "Custom Reference" : ref,
            refImage: ref, 
            generatedImage: `data:image/png;base64,${imageData}`,
            note: stylistNote
        });
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      console.error("Worker Error:", err.message);
      return new Response(JSON.stringify({ error: err.message }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};