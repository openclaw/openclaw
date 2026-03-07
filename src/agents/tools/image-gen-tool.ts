import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { SGLANG_DIFFUSION_DEFAULT_BASE_URL } from "../../commands/sglang-diffusion-setup.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureMediaDir } from "../../media/store.js";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../model-auth.js";
import type { AnyAgentTool } from "./common.js";
import { imageResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("tools/image-gen");

type ImageGenResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};

const ImageGenToolSchema = Type.Object({
  prompt: Type.String({ description: "Text description of the image to generate." }),
  size: Type.Optional(
    Type.String({
      description: "Image size (e.g. 1024x1024, 1024x768). Defaults to 1024x1024.",
    }),
  ),
  negative_prompt: Type.Optional(
    Type.String({ description: "What to avoid in the generated image." }),
  ),
  num_inference_steps: Type.Optional(
    Type.Integer({ description: "Number of diffusion denoising steps.", minimum: 1 }),
  ),
  guidance_scale: Type.Optional(
    Type.Number({ description: "Classifier-free guidance scale (higher = closer to prompt)." }),
  ),
  seed: Type.Optional(
    Type.Integer({ description: "Random seed for reproducible generation.", minimum: 0 }),
  ),
});

function resolveSecretInputString(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (input && typeof input === "object" && "source" in input && "id" in input) {
    // SecretRef with source=env: resolve the env var
    const ref = input as { source?: string; id?: string };
    if (ref.source === "env" && ref.id) {
      return process.env[ref.id]?.trim() ?? "";
    }
  }
  return "";
}

// Env var names onboarding may write as bare placeholders.
const KNOWN_ENV_VAR_NAMES = new Set(["SGLANG_DIFFUSION_API_KEY"]);

function resolveApiKeyString(raw: unknown): string {
  let apiKey = resolveSecretInputString(raw);
  // Resolve ${ENV_VAR} interpolation syntax
  const envWrapMatch = /^\$\{([A-Z0-9_]+)\}$/.exec(apiKey);
  if (envWrapMatch?.[1]) {
    apiKey = process.env[envWrapMatch[1]]?.trim() ?? "";
  } else if (KNOWN_ENV_VAR_NAMES.has(apiKey)) {
    // Bare env var name written by onboarding — resolve from environment
    apiKey = process.env[apiKey]?.trim() ?? "";
  }
  return apiKey;
}

function resolveSglangDiffusionConfig(cfg?: OpenClawConfig): {
  baseUrl: string;
  apiKey: string;
} | null {
  // Primary: tools.imageGen config section
  const imageGen = cfg?.tools?.imageGen;
  if (imageGen?.provider || imageGen?.baseUrl || imageGen?.apiKey) {
    const baseUrl = (imageGen.baseUrl?.trim() || SGLANG_DIFFUSION_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    return { baseUrl, apiKey: resolveApiKeyString(imageGen.apiKey) };
  }

  // Backward compat: legacy models.providers["sglang-diffusion"] location
  const provider = cfg?.models?.providers?.["sglang-diffusion"];
  if (provider) {
    const baseUrl = (provider.baseUrl?.trim() || SGLANG_DIFFUSION_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    return { baseUrl, apiKey: resolveApiKeyString(provider.apiKey) };
  }

  // Fallback: resolve from env
  const envResult = resolveEnvApiKey("sglang-diffusion");
  if (envResult?.apiKey) {
    return { baseUrl: SGLANG_DIFFUSION_DEFAULT_BASE_URL, apiKey: envResult.apiKey };
  }

  return null;
}

export function createImageGenTool(opts?: {
  config?: OpenClawConfig;
  agentDir?: string;
}): AnyAgentTool | null {
  const cfg = opts?.config ?? loadConfig();
  const resolved = resolveSglangDiffusionConfig(cfg);
  if (!resolved) {
    return null;
  }

  const agentDir = opts?.agentDir;

  return {
    label: "Image Generation",
    name: "image_gen",
    description:
      "Generate an image from a text prompt using a local SGLang-Diffusion server. " +
      "Returns the generated image. Supports FLUX, Qwen-Image, and other diffusion models.",
    parameters: ImageGenToolSchema,
    execute: async (_toolCallId, args, signal) => {
      try {
        const params = args as Record<string, unknown>;
        const prompt = readStringParam(params, "prompt", { required: true });
        const size = readStringParam(params, "size") || "1024x1024";
        const negativePrompt = readStringParam(params, "negative_prompt");

        const numInferenceSteps =
          typeof params.num_inference_steps === "number" ? params.num_inference_steps : undefined;
        const guidanceScale =
          typeof params.guidance_scale === "number" ? params.guidance_scale : undefined;
        const seed = typeof params.seed === "number" ? params.seed : undefined;

        // Re-resolve at execution time so hot config changes are picked up
        const runtimeCfg = loadConfig();
        const runtime = resolveSglangDiffusionConfig(runtimeCfg);
        if (!runtime) {
          return {
            content: [{ type: "text", text: "SGLang-Diffusion provider is not configured." }],
            details: { error: "not_configured" },
          };
        }

        // Fallback: if config-based key is empty, try the auth profile store
        // (onboarding stores the actual key there via upsertAuthProfileWithLock)
        if (!runtime.apiKey) {
          try {
            const authResult = await resolveApiKeyForProvider({
              provider: "sglang-diffusion",
              cfg: runtimeCfg,
              agentDir,
            });
            if (authResult?.apiKey) {
              runtime.apiKey = authResult.apiKey;
            }
          } catch (err) {
            log.warn(
              `auth profile lookup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Note: `model` is intentionally omitted from the request body. SGLang-Diffusion
        // serves one model per server instance and ignores the `model` field entirely.
        // The configured tools.imageGen.model is for documentation/UI purposes only.
        const body: Record<string, unknown> = {
          prompt,
          size,
          n: 1,
          response_format: "b64_json",
        };
        if (negativePrompt) {
          body.negative_prompt = negativePrompt;
        }
        if (numInferenceSteps !== undefined) {
          body.num_inference_steps = numInferenceSteps;
        }
        if (guidanceScale !== undefined) {
          body.guidance_scale = guidanceScale;
        }
        if (seed !== undefined) {
          body.seed = seed;
        }

        const url = `${runtime.baseUrl}/images/generations`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (runtime.apiKey) {
          headers.Authorization = `Bearer ${runtime.apiKey}`;
        }

        const timeoutSignal = AbortSignal.timeout(120_000);
        const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          log.warn(`SGLang-Diffusion request failed: ${response.status} ${errorText}`);
          return {
            content: [
              {
                type: "text",
                text: `Image generation failed (HTTP ${response.status}): ${errorText.slice(0, 200)}`,
              },
            ],
            details: { error: "http_error", status: response.status },
          };
        }

        const data = (await response.json()) as ImageGenResponse;
        const imageData = data.data?.[0];

        if (!imageData?.b64_json) {
          return {
            content: [{ type: "text", text: "No image data returned from SGLang-Diffusion." }],
            details: { error: "empty_response" },
          };
        }

        const imageBuffer = Buffer.from(imageData.b64_json, "base64");
        const mediaDir = await ensureMediaDir();
        const filename = `sglang-gen-${crypto.randomUUID()}.png`;
        const filePath = path.join(mediaDir, filename);
        await fs.writeFile(filePath, imageBuffer, { mode: 0o644 });

        // Sanitize server-controlled text: collapse newlines and strip MEDIA: tokens
        // to prevent injection of extra media directives in tool-result output.
        const sanitized = imageData.revised_prompt
          ?.replace(/[\r\n]+/g, " ")
          .replace(/\bMEDIA:/gi, "")
          .trim();
        const revisedNote = sanitized ? `\nRevised prompt: ${sanitized}` : "";

        return await imageResult({
          label: "Image Generation",
          path: filePath,
          base64: imageData.b64_json,
          mimeType: "image/png",
          extraText: `MEDIA:${filePath}${revisedNote}`,
          details: { prompt, size, provider: "sglang-diffusion" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`SGLang-Diffusion image generation error: ${message}`);
        return {
          content: [{ type: "text", text: `Image generation failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
