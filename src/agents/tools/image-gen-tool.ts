import { Type } from "@sinclair/typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { AnyAgentTool } from "./common.js";
import { imageResult, readNumberParam, readStringParam } from "./common.js";

const FLUX_ENDPOINT = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev";
const TIMEOUT_MS = 60_000;

const ImageGenToolSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate." }),
  width: Type.Optional(Type.Number({ description: "Image width in pixels (default 1024)." })),
  height: Type.Optional(Type.Number({ description: "Image height in pixels (default 1024)." })),
  steps: Type.Optional(Type.Number({ description: "Number of diffusion steps (default 30)." })),
  cfg_scale: Type.Optional(
    Type.Number({ description: "Classifier-free guidance scale (default 3.5)." }),
  ),
});

function resolveNvidiaApiKey(cfg: OpenClawConfig): string | undefined {
  const providers = cfg.models?.providers;
  if (providers) {
    for (const p of Object.values(providers)) {
      if (p.baseUrl?.includes("integrate.api.nvidia.com") && typeof p.apiKey === "string") {
        return p.apiKey;
      }
    }
  }
  return process.env.NVIDIA_API_KEY;
}

export function createImageGenTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Image Gen",
    name: "image_gen",
    description: `Generate an image from a text prompt using FLUX.1-dev. The generated image is delivered automatically — reply with ${SILENT_REPLY_TOKEN} after a successful call to avoid duplicate messages.`,
    parameters: ImageGenToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true });
      const width = readNumberParam(params, "width", { integer: true }) ?? 1024;
      const height = readNumberParam(params, "height", { integer: true }) ?? 1024;
      const steps = readNumberParam(params, "steps", { integer: true }) ?? 30;
      const cfgScale = readNumberParam(params, "cfg_scale") ?? 3.5;

      const cfg = opts?.config ?? loadConfig();
      const apiKey = resolveNvidiaApiKey(cfg);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "NVIDIA API key not found. Configure a provider with integrate.api.nvidia.com or set NVIDIA_API_KEY.",
            },
          ],
          details: { error: "missing-api-key" },
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(FLUX_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            prompt,
            width,
            height,
            mode: "base",
            cfg_scale: cfgScale,
            steps,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            content: [{ type: "text", text: `FLUX.1 API error ${res.status}: ${body}` }],
            details: { error: `http-${res.status}` },
          };
        }

        const json = (await res.json()) as {
          artifacts?: Array<{ base64?: string; seed?: number }>;
        };
        const artifact = json.artifacts?.[0];
        if (!artifact?.base64) {
          return {
            content: [{ type: "text", text: "FLUX.1 returned no image data." }],
            details: { error: "no-image-data" },
          };
        }

        const buffer = Buffer.from(artifact.base64, "base64");
        const saved = await saveMediaBuffer(buffer, "image/jpeg", "outbound");

        return await imageResult({
          label: "Image Gen",
          path: saved.path,
          base64: artifact.base64,
          mimeType: "image/jpeg",
          extraText: `MEDIA:${saved.path}`,
          details: { prompt, seed: artifact.seed, width, height, steps },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Image generation failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
