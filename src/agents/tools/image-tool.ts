import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { getDefaultLocalRoots, loadWebMedia } from "../../web/media.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { getApiKeyForModel, requireApiKey, resolveEnvApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { resolveConfiguredModelRef } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import {
  resolveSandboxedBridgeMediaPath,
  type SandboxedBridgeMediaPathConfig,
} from "../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { normalizeWorkspaceDir } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import {
  coerceImageAssistantText,
  coerceImageModelConfig,
  decodeDataUrl,
  type ImageModelConfig,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";

const DEFAULT_PROMPT = "Describe the image.";
const ANTHROPIC_IMAGE_PRIMARY = "anthropic/claude-opus-4-6";
const ANTHROPIC_IMAGE_FALLBACK = "anthropic/claude-opus-4-5";
const DEFAULT_MAX_IMAGES = 20;

export const __testing = {
  decodeDataUrl,
  coerceImageAssistantText,
  resolveImageToolMaxTokens,
} as const;

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function resolveDefaultModelRef(cfg?: OpenClawConfig): {
  provider: string;
  model: string;
} {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

function hasAuthForProvider(params: { provider: string; agentDir: string }): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(store, params.provider).length > 0;
}

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
  if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
    return explicit;
  }

  const primary = resolveDefaultModelRef(params.cfg);
  const openaiOk = hasAuthForProvider({
    provider: "openai",
    agentDir: params.agentDir,
  });
  const anthropicOk = hasAuthForProvider({
    provider: "anthropic",
    agentDir: params.agentDir,
  });

  const fallbacks: string[] = [];
  const addFallback = (modelRef: string | null) => {
    const ref = (modelRef ?? "").trim();
    if (!ref) {
      return;
    }
    if (fallbacks.includes(ref)) {
      return;
    }
    fallbacks.push(ref);
  };

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const providerOk = hasAuthForProvider({
    provider: primary.provider,
    agentDir: params.agentDir,
  });

  let preferred: string | null = null;

  // MiniMax users: always try the canonical vision model first when auth exists.
  if (primary.provider === "minimax" && providerOk) {
    preferred = "minimax/MiniMax-VL-01";
  } else if (providerOk && providerVisionFromConfig) {
    preferred = providerVisionFromConfig;
  } else if (primary.provider === "zai" && providerOk) {
    preferred = "zai/glm-4.6v";
  } else if (primary.provider === "openai" && openaiOk) {
    preferred = "openai/gpt-5-mini";
  } else if (primary.provider === "anthropic" && anthropicOk) {
    preferred = ANTHROPIC_IMAGE_PRIMARY;
  }

  if (preferred?.trim()) {
    if (openaiOk) {
      addFallback("openai/gpt-5-mini");
    }
    if (anthropicOk) {
      addFallback(ANTHROPIC_IMAGE_FALLBACK);
    }
    // Don't duplicate primary in fallbacks.
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return {
      primary: preferred,
      ...(pruned.length > 0 ? { fallbacks: pruned } : {}),
    };
  }

  // Cross-provider fallback when we can't pair with the primary provider.
  if (openaiOk) {
    if (anthropicOk) {
      addFallback(ANTHROPIC_IMAGE_FALLBACK);
    }
    return {
      primary: "openai/gpt-5-mini",
      ...(fallbacks.length ? { fallbacks } : {}),
    };
  }
  if (anthropicOk) {
    return {
      primary: ANTHROPIC_IMAGE_PRIMARY,
      fallbacks: [ANTHROPIC_IMAGE_FALLBACK],
    };
  }

  return null;
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

function buildImageContext(
  prompt: string,
  images: Array<{ base64: string; mimeType: string }>,
): Context {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: prompt }];
  for (const img of images) {
    content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
  }
  return {
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

type ImageSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runImagePrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  images: Array<{ base64: string; mimeType: string }>;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg: OpenClawConfig | undefined = params.cfg
    ? {
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          defaults: {
            ...params.cfg.agents?.defaults,
            imageModel: params.imageModelConfig,
          },
        },
      }
    : undefined;

  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }
      if (!model.input?.includes("image")) {
        throw new Error(`Model does not support images: ${provider}/${modelId}`);
      }
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
      });
      const apiKey = requireApiKey(apiKeyInfo, model.provider);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      // MiniMax VLM only supports a single image; use the first one.
      if (model.provider === "minimax") {
        const first = params.images[0];
        const imageDataUrl = `data:${first.mimeType};base64,${first.base64}`;
        const text = await minimaxUnderstandImage({
          apiKey,
          prompt: params.prompt,
          imageDataUrl,
          modelBaseUrl: model.baseUrl,
        });
        return { text, provider: model.provider, model: model.id };
      }

      const context = buildImageContext(params.prompt, params.images);
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolveImageToolMaxTokens(model.maxTokens),
      });
      const text = coerceImageAssistantText({
        message,
        provider: model.provider,
        model: model.id,
      });
      return { text, provider: model.provider, model: model.id };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      error: attempt.error,
    })),
  };
}

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
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
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

  const localRoots = (() => {
    const roots = getDefaultLocalRoots();
    const workspaceDir = normalizeWorkspaceDir(options?.workspaceDir);
    if (!workspaceDir) {
      return roots;
    }
    return Array.from(new Set([...roots, workspaceDir]));
  })();

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

      const promptRaw =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;
      const modelOverride =
        typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
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
        base64: string;
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

        const media = isDataUrl
          ? decodeDataUrl(resolvedImage)
          : sandboxConfig
            ? await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                sandboxValidated: true,
                readFile: (filePath) =>
                  sandboxConfig.bridge.readFile({ filePath, cwd: sandboxConfig.root }),
              })
            : await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                localRoots,
              });
        if (media.kind !== "image") {
          throw new Error(`Unsupported media type: ${media.kind}`);
        }

        const mimeType =
          ("contentType" in media && media.contentType) ||
          ("mimeType" in media && media.mimeType) ||
          "image/png";
        const base64 = media.buffer.toString("base64");
        loadedImages.push({
          base64,
          mimeType,
          resolvedImage,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      // MARK: - Run image prompt with all loaded images
      const result = await runImagePrompt({
        cfg: options?.config,
        agentDir,
        imageModelConfig,
        modelOverride,
        prompt: promptRaw,
        images: loadedImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
      });

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

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: `${result.provider}/${result.model}`,
          ...imageDetails,
          attempts: result.attempts,
        },
      };
    },
  };
}
