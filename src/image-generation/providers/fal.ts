import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import type { ImageGenerationProviderPlugin } from "../../plugins/types.js";
import type { GeneratedImageAsset } from "../types.js";

const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/dev";
const DEFAULT_FAL_EDIT_SUBPATH = "image-to-image";
const DEFAULT_OUTPUT_SIZE = "square_hd";
const DEFAULT_OUTPUT_FORMAT = "png";

type FalGeneratedImage = {
  url?: string;
  content_type?: string;
};

type FalImageGenerationResponse = {
  images?: FalGeneratedImage[];
  prompt?: string;
};

type FalImageSize = string | { width: number; height: number };

function resolveFalBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const direct = cfg?.models?.providers?.fal?.baseUrl?.trim();
  return (direct || DEFAULT_FAL_BASE_URL).replace(/\/+$/u, "");
}

function ensureFalModelPath(model: string | undefined, hasInputImages: boolean): string {
  const trimmed = model?.trim() || DEFAULT_FAL_IMAGE_MODEL;
  if (!hasInputImages) {
    return trimmed;
  }
  if (
    trimmed.endsWith(`/${DEFAULT_FAL_EDIT_SUBPATH}`) ||
    trimmed.endsWith("/edit") ||
    trimmed.includes("/image-to-image/")
  ) {
    return trimmed;
  }
  return `${trimmed}/${DEFAULT_FAL_EDIT_SUBPATH}`;
}

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function mapResolutionToSize(resolution: "1K" | "2K" | "4K" | undefined): FalImageSize | undefined {
  if (!resolution) {
    return undefined;
  }
  const edge = resolution === "4K" ? 4096 : resolution === "2K" ? 2048 : 1024;
  return { width: edge, height: edge };
}

function resolveFalImageSize(params: {
  size?: string;
  resolution?: "1K" | "2K" | "4K";
}): FalImageSize {
  const parsed = parseSize(params.size);
  if (parsed) {
    return parsed;
  }
  return mapResolutionToSize(params.resolution) ?? DEFAULT_OUTPUT_SIZE;
}

function toDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function fileExtensionForMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.toLowerCase().trim();
  if (!normalized) {
    return "png";
  }
  if (normalized.includes("jpeg")) {
    return "jpg";
  }
  const slashIndex = normalized.indexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) || "png" : "png";
}

async function fetchImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `fal image download failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const mimeType = response.headers.get("content-type")?.trim() || "image/png";
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

export function buildFalImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_IMAGE_MODEL,
    models: [DEFAULT_FAL_IMAGE_MODEL, `${DEFAULT_FAL_IMAGE_MODEL}/${DEFAULT_FAL_EDIT_SUBPATH}`],
    supportedSizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
    supportedResolutions: ["1K", "2K", "4K"],
    supportsImageEditing: true,
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "fal",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("fal API key missing");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("fal image generation currently supports at most one reference image");
      }

      const imageSize = resolveFalImageSize({
        size: req.size,
        resolution: req.resolution,
      });
      const hasInputImages = (req.inputImages?.length ?? 0) > 0;
      const model = ensureFalModelPath(req.model, hasInputImages);
      const requestBody: Record<string, unknown> = {
        prompt: req.prompt,
        image_size: imageSize,
        num_images: req.count ?? 1,
        output_format: DEFAULT_OUTPUT_FORMAT,
      };

      if (hasInputImages) {
        const [input] = req.inputImages ?? [];
        if (!input) {
          throw new Error("fal image edit request missing reference image");
        }
        requestBody.image_url = toDataUri(input.buffer, input.mimeType);
      }

      const response = await fetch(`${resolveFalBaseUrl(req.cfg)}/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `fal image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const payload = (await response.json()) as FalImageGenerationResponse;
      const images: GeneratedImageAsset[] = [];
      let imageIndex = 0;
      for (const entry of payload.images ?? []) {
        const url = entry.url?.trim();
        if (!url) {
          continue;
        }
        const downloaded = await fetchImageBuffer(url);
        imageIndex += 1;
        images.push({
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
          fileName: `image-${imageIndex}.${fileExtensionForMimeType(
            downloaded.mimeType || entry.content_type,
          )}`,
        });
      }

      if (images.length === 0) {
        throw new Error("fal image generation response missing image data");
      }

      return {
        images,
        model,
        metadata: payload.prompt ? { prompt: payload.prompt } : undefined,
      };
    },
  };
}
