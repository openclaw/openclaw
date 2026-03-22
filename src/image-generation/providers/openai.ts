import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import type { ImageGenerationProviderPlugin } from "../../plugins/types.js";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "../../providers/openai-defaults.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const OPENAI_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

function resolveOpenAIBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const direct = cfg?.models?.providers?.openai?.baseUrl?.trim();
  return direct || DEFAULT_OPENAI_IMAGE_BASE_URL;
}

function resolveOpenAISize(params: { size?: string; aspectRatio?: string }): string {
  const explicitSize = params.size?.trim();
  if (explicitSize) {
    return explicitSize;
  }

  switch (params.aspectRatio?.trim()) {
    case "1:1":
      return "1024x1024";
    case "2:3":
    case "3:4":
    case "4:5":
    case "9:16":
      return "1024x1536";
    case "3:2":
    case "4:3":
    case "5:4":
    case "16:9":
    case "21:9":
      return "1536x1024";
    default:
      return DEFAULT_SIZE;
  }
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [DEFAULT_OPENAI_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
        aspectRatios: [...OPENAI_SUPPORTED_ASPECT_RATIOS],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("OpenAI image generation provider does not support reference-image edits");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "openai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenAI API key missing");
      }

      const controller = new AbortController();
      const timeoutMs = req.timeoutMs;
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

      const response = await fetch(`${resolveOpenAIBaseUrl(req.cfg)}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model || DEFAULT_OPENAI_IMAGE_MODEL,
          prompt: req.prompt,
          n: req.count ?? 1,
          size: resolveOpenAISize({ size: req.size, aspectRatio: req.aspectRatio }),
        }),
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeout);
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `OpenAI image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIImageApiResponse;
      const images = (data.data ?? [])
        .map((entry, index) => {
          if (!entry.b64_json) {
            return null;
          }
          return {
            buffer: Buffer.from(entry.b64_json, "base64"),
            mimeType: DEFAULT_OUTPUT_MIME,
            fileName: `image-${index + 1}.png`,
            ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      return {
        images,
        model: req.model || DEFAULT_OPENAI_IMAGE_MODEL,
      };
    },
  };
}
