import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { normalizeGoogleModelId } from "../../agents/model-id-normalization.js";
import { parseGeminiAuth } from "../../infra/gemini-auth.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
} from "../../media-understanding/providers/shared.js";
import type { ImageGenerationProviderPlugin } from "../../plugins/types.js";

const DEFAULT_GOOGLE_IMAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_ASPECT_RATIO = "1:1";

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateImageResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

function resolveGoogleBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const direct = cfg?.models?.providers?.google?.baseUrl?.trim();
  return direct || DEFAULT_GOOGLE_IMAGE_BASE_URL;
}

function normalizeGoogleImageModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return normalizeGoogleModelId(trimmed || DEFAULT_GOOGLE_IMAGE_MODEL);
}

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const trimmed = size?.trim();
  if (!trimmed) {
    return { aspectRatio: DEFAULT_ASPECT_RATIO };
  }

  const normalized = trimmed.toLowerCase();
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);

  const [widthRaw, heightRaw] = normalized.split("x");
  const width = Number.parseInt(widthRaw ?? "", 10);
  const height = Number.parseInt(heightRaw ?? "", 10);
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

export function buildGoogleImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "google",
    label: "Google",
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const model = normalizeGoogleImageModel(req.model);
      const baseUrl = normalizeBaseUrl(
        resolveGoogleBaseUrl(req.cfg),
        DEFAULT_GOOGLE_IMAGE_BASE_URL,
      );
      const allowPrivate = Boolean(req.cfg?.models?.providers?.google?.baseUrl?.trim());
      const authHeaders = parseGeminiAuth(auth.apiKey);
      const headers = new Headers(authHeaders.headers);
      const imageConfig = mapSizeToImageConfig(req.size);

      const { response: res, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}:generateContent`,
        headers,
        body: {
          contents: [
            {
              role: "user",
              parts: [{ text: req.prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(imageConfig ? { imageConfig } : {}),
          },
        },
        timeoutMs: 60_000,
        fetchFn: fetch,
        allowPrivateNetwork: allowPrivate,
      });

      try {
        await assertOkOrThrowHttpError(res, "Google image generation failed");

        const payload = (await res.json()) as GoogleGenerateImageResponse;
        let imageIndex = 0;
        const images = (payload.candidates ?? [])
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => {
            const inline = part.inlineData ?? part.inline_data;
            const data = inline?.data?.trim();
            if (!data) {
              return null;
            }
            const mimeType = inline?.mimeType ?? inline?.mime_type ?? DEFAULT_OUTPUT_MIME;
            const extension = mimeType.includes("jpeg") ? "jpg" : (mimeType.split("/")[1] ?? "png");
            imageIndex += 1;
            return {
              buffer: Buffer.from(data, "base64"),
              mimeType,
              fileName: `image-${imageIndex}.${extension}`,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (images.length === 0) {
          throw new Error("Google image generation response missing image data");
        }

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
