import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import type { ImageGenerationProviderPlugin } from "../../plugins/types.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";

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

export function buildOpenAIImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [DEFAULT_OPENAI_IMAGE_MODEL],
    supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
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
          size: req.size ?? DEFAULT_SIZE,
        }),
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
