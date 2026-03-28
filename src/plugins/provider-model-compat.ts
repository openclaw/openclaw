import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelCompatConfig } from "../config/types.models.js";

function extractModelCompat(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  if (!modelOrCompat || typeof modelOrCompat !== "object") {
    return undefined;
  }
  if ("compat" in modelOrCompat) {
    const compat = (modelOrCompat as { compat?: unknown }).compat;
    return compat && typeof compat === "object" ? (compat as ModelCompatConfig) : undefined;
  }
  return modelOrCompat as ModelCompatConfig;
}

export function applyModelCompatPatch<T extends { compat?: ModelCompatConfig }>(
  model: T,
  patch: ModelCompatConfig,
): T {
  const nextCompat = { ...model.compat, ...patch };
  if (
    model.compat &&
    Object.entries(patch).every(
      ([key, value]) => model.compat?.[key as keyof ModelCompatConfig] === value,
    )
  ) {
    return model;
  }
  return {
    ...model,
    compat: nextCompat,
  };
}

export function hasToolSchemaProfile(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
  profile: string,
): boolean {
  return extractModelCompat(modelOrCompat)?.toolSchemaProfile === profile;
}

export function hasNativeWebSearchTool(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): boolean {
  return extractModelCompat(modelOrCompat)?.nativeWebSearchTool === true;
}

export function resolveToolCallArgumentsEncoding(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ModelCompatConfig["toolCallArgumentsEncoding"] | undefined {
  return extractModelCompat(modelOrCompat)?.toolCallArgumentsEncoding;
}

export function resolveUnsupportedToolSchemaKeywords(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ReadonlySet<string> {
  const keywords = extractModelCompat(modelOrCompat)?.unsupportedToolSchemaKeywords ?? [];
  return new Set(
    keywords
      .filter((keyword): keyword is string => typeof keyword === "string")
      .map((keyword) => keyword.trim())
      .filter(Boolean),
  );
}

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Extracts and lowercases the hostname from a URL string.
 * Returns null for malformed URLs.
 */
function getHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns true only for endpoints that are confirmed to be native OpenAI
 * infrastructure and therefore accept the `developer` message role.
 * Custom proxies that happen to speak the OpenAI protocol typically
 * only support the standard `system` role.
 */
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  return getHostname(baseUrl) === "api.openai.com";
}

/**
 * Returns true for Mistral AI endpoints (official or compatible).
 * Mistral's OpenAI-compatible /chat/completions endpoint is stricter than
 * OpenAI-native backends and rejects several request flags.
 */
function isMistralEndpoint(model: Model<Api>): boolean {
  return model.provider === "mistral" || getHostname(model.baseUrl ?? "") === "api.mistral.ai";
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";

  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalized = normalizeAnthropicBaseUrl(baseUrl);
    if (normalized !== baseUrl) {
      return { ...model, baseUrl: normalized } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const compat = model.compat ?? undefined;
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }
  const forcedDeveloperRole = compat?.supportsDeveloperRole === true;
  const hasStreamingUsageOverride = compat?.supportsUsageInStreaming !== undefined;
  const targetStrictMode = compat?.supportsStrictMode ?? false;
  const forcedUsageStreaming = compat?.supportsUsageInStreaming === true;

  // Don't early-return for Mistral endpoints — they need additional flags
  // forced off even when developer role and usage streaming are already set.
  if (
    compat?.supportsDeveloperRole !== undefined &&
    hasStreamingUsageOverride &&
    compat?.supportsStrictMode !== undefined &&
    !isMistralEndpoint(model)
  ) {
    return model;
  }

  const baseCompat: ModelCompatConfig = compat
    ? {
        ...compat,
        supportsDeveloperRole: forcedDeveloperRole || false,
        supportsUsageInStreaming: forcedUsageStreaming || false,
        supportsStrictMode: targetStrictMode,
      }
    : { supportsDeveloperRole: false, supportsUsageInStreaming: false, supportsStrictMode: false };

  // Mistral's OpenAI-compatible /chat/completions endpoint is stricter than
  // OpenAI-native backends: it rejects `store`, uses `max_tokens` instead of
  // `max_completion_tokens`, and does not support OpenAI-style
  // `reasoning_effort`.
  const mistralOverrides: Partial<ModelCompatConfig> = isMistralEndpoint(model)
    ? { supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" }
    : {};

  return {
    ...model,
    compat: { ...baseCompat, ...mistralOverrides },
  } as typeof model;
}
