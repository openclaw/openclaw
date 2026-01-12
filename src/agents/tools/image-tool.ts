import {
  type Api,
  type AssistantMessage,
  type Context,
  complete,
  type Model,
} from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { loadWebMedia } from "../../web/media.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { getApiKeyForModel, resolveEnvApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { parseModelRef } from "../model-selection.js";
import { ensureClawdbotModelsJson } from "../models-config.js";
import { extractAssistantText } from "../pi-embedded-utils.js";
import type { AnyAgentTool } from "./common.js";

const DEFAULT_PROMPT = "Describe the image.";

type ImageModelConfig = { primary?: string; fallbacks?: string[] };

function coerceImageModelConfig(cfg?: ClawdbotConfig): ImageModelConfig {
  const imageModel = cfg?.agents?.defaults?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const primary =
    typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
  const fallbacks =
    typeof imageModel === "object" ? (imageModel?.fallbacks ?? []) : [];
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function resolveProviderVisionModelFromConfig(params: {
  cfg?: ClawdbotConfig;
  provider: string;
}): string | null {
  const providerCfg = params.cfg?.models?.providers?.[
    params.provider
  ] as unknown as
    | { models?: Array<{ id?: string; input?: string[] }> }
    | undefined;
  const models = providerCfg?.models ?? [];
  const preferMinimaxVl =
    params.provider === "minimax"
      ? models.find(
          (m) =>
            (m?.id ?? "").trim() === "MiniMax-VL-01" &&
            Array.isArray(m?.input) &&
            m.input.includes("image"),
        )
      : null;
  const picked =
    preferMinimaxVl ??
    models.find(
      (m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"),
    );
  const id = (picked?.id ?? "").trim();
  return id ? `${params.provider}/${id}` : null;
}

function resolveDefaultModelRef(cfg?: ClawdbotConfig): {
  provider: string;
  model: string;
} {
  const modelConfig = cfg?.agents?.defaults?.model as
    | { primary?: string }
    | string
    | undefined;
  const raw =
    typeof modelConfig === "string"
      ? modelConfig.trim()
      : modelConfig?.primary?.trim();
  const parsed =
    parseModelRef(raw ?? "", DEFAULT_PROVIDER) ??
    ({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL } as const);
  return { provider: parsed.provider, model: parsed.model };
}

function hasAuthForProvider(params: {
  provider: string;
  agentDir: string;
}): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) return true;
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
  cfg?: ClawdbotConfig;
  agentDir: string;
}): ImageModelConfig | null {
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
    if (!ref) return;
    if (fallbacks.includes(ref)) return;
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
  } else if (primary.provider === "openai" && openaiOk) {
    preferred = "openai/gpt-5-mini";
  } else if (primary.provider === "anthropic" && anthropicOk) {
    preferred = "anthropic/claude-opus-4-5";
  }

  if (preferred?.trim()) {
    if (openaiOk) addFallback("openai/gpt-5-mini");
    if (anthropicOk) addFallback("anthropic/claude-opus-4-5");
    // Don't duplicate primary in fallbacks.
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return {
      primary: preferred,
      ...(pruned.length > 0 ? { fallbacks: pruned } : {}),
    };
  }

  // Cross-provider fallback when we can't pair with the primary provider.
  if (openaiOk) {
    if (anthropicOk) addFallback("anthropic/claude-opus-4-5");
    return {
      primary: "openai/gpt-5-mini",
      ...(fallbacks.length ? { fallbacks } : {}),
    };
  }
  if (anthropicOk) {
    return { primary: "anthropic/claude-opus-4-5" };
  }

  return null;
}

function pickMaxBytes(
  cfg?: ClawdbotConfig,
  maxBytesMb?: number,
): number | undefined {
  if (
    typeof maxBytesMb === "number" &&
    Number.isFinite(maxBytesMb) &&
    maxBytesMb > 0
  ) {
    return Math.floor(maxBytesMb * 1024 * 1024);
  }
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function buildImageContext(
  prompt: string,
  base64: string,
  mimeType: string,
): Context {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", data: base64, mimeType },
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

async function runImagePrompt(params: {
  cfg?: ClawdbotConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  base64: string;
  mimeType: string;
}): Promise<{ text: string; provider: string; model: string }> {
  const effectiveCfg: ClawdbotConfig | undefined = params.cfg
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

  await ensureClawdbotModelsJson(effectiveCfg, params.agentDir);
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
        throw new Error(
          `Model does not support images: ${provider}/${modelId}`,
        );
      }
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
      });
      authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
      const context = buildImageContext(
        params.prompt,
        params.base64,
        params.mimeType,
      );
      const message = (await complete(model, context, {
        apiKey: apiKeyInfo.apiKey,
        maxTokens: 512,
        temperature: 0,
      })) as AssistantMessage;
      return message;
    },
  });

  const text = extractAssistantText(result.result);
  return {
    text: text || "(no text returned)",
    provider: result.provider,
    model: result.model,
  };
}

export function createImageTool(options?: {
  config?: ClawdbotConfig;
  agentDir?: string;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir;
  if (!agentDir?.trim()) {
    throw new Error("createImageTool requires agentDir when enabled");
  }
  const imageModelConfig = resolveImageModelConfigForTool({
    cfg: options?.config,
    agentDir,
  });
  if (!imageModelConfig) return null;
  return {
    label: "Image",
    name: "image",
    description:
      "Analyze an image with the configured image model (agents.defaults.imageModel). Provide a prompt and image path or URL.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.String(),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const imageRaw =
        typeof record.image === "string" ? record.image.trim() : "";
      if (!imageRaw) throw new Error("image required");
      const promptRaw =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;
      const modelOverride =
        typeof record.model === "string" && record.model.trim()
          ? record.model.trim()
          : undefined;
      const maxBytesMb =
        typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);

      const resolvedImage = imageRaw.startsWith("~")
        ? resolveUserPath(imageRaw)
        : imageRaw;
      const media = await loadWebMedia(resolvedImage, maxBytes);
      if (media.kind !== "image") {
        throw new Error(`Unsupported media type: ${media.kind}`);
      }

      const mimeType = media.contentType ?? "image/png";
      const base64 = media.buffer.toString("base64");
      const result = await runImagePrompt({
        cfg: options?.config,
        agentDir,
        imageModelConfig,
        modelOverride,
        prompt: promptRaw,
        base64,
        mimeType,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: `${result.provider}/${result.model}`,
          image: resolvedImage,
        },
      };
    },
  };
}
