import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveUserPath } from "../../utils.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import {
  coerceImageModelConfig,
  decodeDataUrl,
  type ImageModelConfig,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { resolveMediaToolLocalRoots, resolvePromptAndModelOverride } from "./media-tool-shared.js";
import {
  buildToolModelConfigFromCandidates,
  hasToolModelConfig,
  resolveDefaultModelRef,
} from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxedBridgeMediaPathConfig,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Describe the image.";
const ANTHROPIC_IMAGE_PRIMARY = "anthropic/claude-opus-4-6";
const ANTHROPIC_IMAGE_FALLBACK = "anthropic/claude-opus-4-5";
const DEFAULT_MAX_IMAGES = 20;

export const __testing = {
  decodeDataUrl,
} as const;

/**
 * Resolve the effective image model config for the `image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
export function resolveImageModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
}): ImageModelConfig | null {
  // Note: We intentionally do NOT gate based on primarySupportsImages here.
  // Even when the primary model supports images, we keep the tool available
  // because images are auto-injected into prompts (see attempt.ts detectAndLoadPromptImages).
  // The tool description is adjusted via modelHasVision to discourage redundant usage.
  const explicit = coerceImageModelConfig(params.cfg);
  if (hasToolModelConfig(explicit)) {
    return explicit;
  }

  const primary = resolveDefaultModelRef(params.cfg);

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const primaryCandidates = (() => {
    if (isMinimaxVlmProvider(primary.provider)) {
      return [`${primary.provider}/MiniMax-VL-01`];
    }
    if (providerVisionFromConfig) {
      return [providerVisionFromConfig];
    }
    if (primary.provider === "zai") {
      return ["zai/glm-4.6v"];
    }
    if (primary.provider === "openai") {
      return ["openai/gpt-5-mini"];
    }
    if (primary.provider === "anthropic") {
      return [ANTHROPIC_IMAGE_PRIMARY];
    }
    return [];
  })();

  return buildToolModelConfigFromCandidates({
    explicit,
    agentDir: params.agentDir,
    candidates: [...primaryCandidates, "openai/gpt-5-mini", ANTHROPIC_IMAGE_FALLBACK],
  });
}

function pickMaxBytes(cfg?: OpenClawConfig, maxBytesMb?: number): number | undefined {
  if (typeof maxBytesMb === "number" && Number.isFinite(maxBytesMb) && maxBytesMb > 0) {
    return Math.floor(maxBytesMb * 1024 * 1024);
  }
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

type ImageSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

export function createImageTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: ImageSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coerceImageModelConfig(options?.config);
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const imageModelConfig = resolveImageModelConfigForTool({
    cfg: options?.config,
    agentDir,
  });
  if (!imageModelConfig) {
    return null;
  }

  // If model has native vision, images in the prompt are auto-injected
  // so this tool is only needed when image wasn't provided in the prompt
  const description = options?.modelHasVision
    ? "Analyze one or more images with a vision model. Use image for a single path/URL, or images for multiple (up to 20). Only use this tool when images were NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you."
    : "Analyze one or more images with the configured image model (agents.defaults.imageModel). Use image for a single path/URL, or images for multiple (up to 20). Provide a prompt describing what to analyze.";

  return {
    label: "Image",
    name: "image",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.Optional(Type.String({ description: "Single image path or URL." })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple image paths or URLs (up to maxImages, default 20).",
        }),
      ),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
      maxImages: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize image + images input and dedupe while preserving order
      const imageCandidates: string[] = [];
      if (typeof record.image === "string") {
        imageCandidates.push(record.image);
      }
      if (Array.isArray(record.images)) {
        imageCandidates.push(...record.images.filter((v): v is string => typeof v === "string"));
      }

      const seenImages = new Set<string>();
      const imageInputs: string[] = [];
      for (const candidate of imageCandidates) {
        const trimmedCandidate = candidate.trim();
        const normalizedForDedupe = trimmedCandidate.startsWith("@")
          ? trimmedCandidate.slice(1).trim()
          : trimmedCandidate;
        if (!normalizedForDedupe || seenImages.has(normalizedForDedupe)) {
          continue;
        }
        seenImages.add(normalizedForDedupe);
        imageInputs.push(trimmedCandidate);
      }
      if (imageInputs.length === 0) {
        throw new Error("image required");
      }

      // MARK: - Enforce max images cap
      const maxImagesRaw = typeof record.maxImages === "number" ? record.maxImages : undefined;
      const maxImages =
        typeof maxImagesRaw === "number" && Number.isFinite(maxImagesRaw) && maxImagesRaw > 0
          ? Math.floor(maxImagesRaw)
          : DEFAULT_MAX_IMAGES;
      if (imageInputs.length > maxImages) {
        return {
          content: [
            {
              type: "text",
              text: `Too many images: ${imageInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`,
            },
          ],
          details: { error: "too_many_images", count: imageInputs.length, max: maxImages },
        };
      }

      const { prompt: promptRaw } = resolvePromptAndModelOverride(record, DEFAULT_PROMPT);
      const maxBytesMb = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);

      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options?.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load and resolve each image
      const loadedImages: Array<{
        buffer: Buffer;
        mimeType: string;
        resolvedImage: string;
        rewrittenFrom?: string;
      }> = [];

      for (const imageRawInput of imageInputs) {
        const trimmed = imageRawInput.trim();
        const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
        if (!imageRaw) {
          throw new Error("image required (empty string in array)");
        }

        // The tool accepts file paths, file/data URLs, or http(s) URLs. In some
        // agent/model contexts, images can be referenced as pseudo-URIs like
        // `image:0` (e.g. "first image in the prompt"). We don't have access to a
        // shared image registry here, so fail gracefully instead of attempting to
        // `fs.readFile("image:0")` and producing a noisy ENOENT.
        const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(imageRaw);
        const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(imageRaw);
        const isFileUrl = /^file:/i.test(imageRaw);
        const isHttpUrl = /^https?:\/\//i.test(imageRaw);
        const isDataUrl = /^data:/i.test(imageRaw);
        if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
          return {
            content: [
              {
                type: "text",
                text: `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
              },
            ],
            details: {
              error: "unsupported_image_reference",
              image: imageRawInput,
            },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed image tool does not allow remote URLs.");
        }

        const resolvedImage = (() => {
          if (sandboxConfig) {
            return imageRaw;
          }
          if (imageRaw.startsWith("~")) {
            return resolveUserPath(imageRaw);
          }
          return imageRaw;
        })();
        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
          ? { resolved: "" }
          : sandboxConfig
            ? await resolveSandboxedBridgeMediaPath({
                sandbox: sandboxConfig,
                mediaPath: resolvedImage,
                inboundFallbackDir: "media/inbound",
              })
            : {
                resolved: resolvedImage.startsWith("file://")
                  ? resolvedImage.slice("file://".length)
                  : resolvedImage,
              };
        const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
        const mediaLocalRoots = resolveMediaToolLocalRoots(
          options?.workspaceDir,
          {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          },
          resolvedPath ? [resolvedPath] : undefined,
        );

        const media = isDataUrl
          ? decodeDataUrl(resolvedImage)
          : sandboxConfig
            ? await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                sandboxValidated: true,
                readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
              })
            : await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                localRoots: mediaLocalRoots,
              });
        if (media.kind !== "image") {
          throw new Error(`Unsupported media type: ${media.kind}`);
        }

        const mimeType =
          ("contentType" in media && media.contentType) ||
          ("mimeType" in media && media.mimeType) ||
          "image/png";
        loadedImages.push({
          buffer: media.buffer,
          mimeType,
          resolvedImage,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      const imageDetails =
        loadedImages.length === 1
          ? {
              image: loadedImages[0].resolvedImage,
              ...(loadedImages[0].rewrittenFrom
                ? { rewrittenFrom: loadedImages[0].rewrittenFrom }
                : {}),
            }
          : {
              images: loadedImages.map((img) => ({
                image: img.resolvedImage,
                ...(img.rewrittenFrom ? { rewrittenFrom: img.rewrittenFrom } : {}),
              })),
            };

      const result = {
        content: [
          { type: "text" as const, text: promptRaw },
          ...loadedImages.map((img) => ({
            type: "image" as const,
            data: img.buffer.toString("base64"),
            mimeType: img.mimeType,
          })),
        ],
        details: imageDetails,
      };

      return await sanitizeToolResultImages(result, "image");
    },
  };
}
