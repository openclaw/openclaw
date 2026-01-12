import fs from "node:fs/promises";
import path from "node:path";

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
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { getApiKeyForModel, resolveEnvApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { parseModelRef } from "../model-selection.js";
import { ensureClawdbotModelsJson } from "../models-config.js";
import { extractAssistantText } from "../pi-embedded-utils.js";
import { assertSandboxPath } from "../sandbox-paths.js";
import type { AnyAgentTool } from "./common.js";

const DEFAULT_PROMPT = "Describe the image.";

type ImageModelConfig = { primary?: string; fallbacks?: string[] };

function decodeDataUrl(dataUrl: string): {
  buffer: Buffer;
  mimeType: string;
  kind: "image";
} {
  const trimmed = dataUrl.trim();
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
  if (!match) throw new Error("Invalid data URL (expected base64 data: URL).");
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
  }
  const b64 = (match[2] ?? "").trim();
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid data URL: empty payload.");
  }
  return { buffer, mimeType, kind: "image" };
}

export const __testing = {
  decodeDataUrl,
  coerceImageAssistantText,
} as const;

function coerceImageAssistantText(params: {
  message: AssistantMessage;
  provider: string;
  model: string;
}): string {
  const stop = params.message.stopReason;
  const errorMessage = params.message.errorMessage?.trim();
  if (stop === "error" || stop === "aborted") {
    throw new Error(
      errorMessage
        ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}`
        : `Image model failed (${params.provider}/${params.model})`,
    );
  }
  if (errorMessage) {
    throw new Error(
      `Image model failed (${params.provider}/${params.model}): ${errorMessage}`,
    );
  }
  const text = extractAssistantText(params.message);
  if (text.trim()) return text.trim();
  throw new Error(
    `Image model returned no text (${params.provider}/${params.model}).`,
  );
}

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

async function resolveSandboxedImagePath(params: {
  sandboxRoot: string;
  imagePath: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const normalize = (p: string) =>
    p.startsWith("file://") ? p.slice("file://".length) : p;
  const filePath = normalize(params.imagePath);
  try {
    const out = await assertSandboxPath({
      filePath,
      cwd: params.sandboxRoot,
      root: params.sandboxRoot,
    });
    return { resolved: out.resolved };
  } catch (err) {
    const name = path.basename(filePath);
    const candidateRel = path.join("media", "inbound", name);
    const candidateAbs = path.join(params.sandboxRoot, candidateRel);
    try {
      await fs.stat(candidateAbs);
    } catch {
      throw err;
    }
    const out = await assertSandboxPath({
      filePath: candidateRel,
      cwd: params.sandboxRoot,
      root: params.sandboxRoot,
    });
    return { resolved: out.resolved, rewrittenFrom: filePath };
  }
}

async function runImagePrompt(params: {
  cfg?: ClawdbotConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  base64: string;
  mimeType: string;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
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
      const imageDataUrl = `data:${params.mimeType};base64,${params.base64}`;

      if (model.provider === "minimax") {
        const text = await minimaxUnderstandImage({
          apiKey: apiKeyInfo.apiKey,
          prompt: params.prompt,
          imageDataUrl,
          modelBaseUrl: model.baseUrl,
        });
        return { text, provider: model.provider, model: model.id };
      }

      const context = buildImageContext(
        params.prompt,
        params.base64,
        params.mimeType,
      );
      const message = (await complete(model, context, {
        apiKey: apiKeyInfo.apiKey,
        maxTokens: 512,
      })) as AssistantMessage;
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
  config?: ClawdbotConfig;
  agentDir?: string;
  sandboxRoot?: string;
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
      const imageRawInput =
        typeof record.image === "string" ? record.image.trim() : "";
      const imageRaw = imageRawInput.startsWith("@")
        ? imageRawInput.slice(1).trim()
        : imageRawInput;
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

      const sandboxRoot = options?.sandboxRoot?.trim();
      const isUrl = /^https?:\/\//i.test(imageRaw);
      if (sandboxRoot && isUrl) {
        throw new Error("Sandboxed image tool does not allow remote URLs.");
      }

      const isDataUrl = /^data:/i.test(imageRaw);
      const resolvedImage = (() => {
        if (sandboxRoot) return imageRaw;
        if (imageRaw.startsWith("~")) return resolveUserPath(imageRaw);
        return imageRaw;
      })();
      const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } =
        isDataUrl
          ? { resolved: "" }
          : sandboxRoot
            ? await resolveSandboxedImagePath({
                sandboxRoot,
                imagePath: resolvedImage,
              })
            : {
                resolved: resolvedImage.startsWith("file://")
                  ? resolvedImage.slice("file://".length)
                  : resolvedImage,
              };
      const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;

      const media = isDataUrl
        ? decodeDataUrl(resolvedImage)
        : await loadWebMedia(resolvedPath ?? resolvedImage, maxBytes);
      if (media.kind !== "image") {
        throw new Error(`Unsupported media type: ${media.kind}`);
      }

      const mimeType =
        ("contentType" in media && media.contentType) ||
        ("mimeType" in media && media.mimeType) ||
        "image/png";
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
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
          attempts: result.attempts,
        },
      };
    },
  };
}
