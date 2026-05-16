import type { Api, Model } from "@earendil-works/pi-ai";
import { detectOpenAICompletionsCompat } from "../agents/openai-completions-compat.js";
import type { ModelCompatConfig } from "../config/types.models.js";

export function extractModelCompat(
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

/** @deprecated Provider-owned model compat helper; do not use from third-party plugins. */
export function applyModelCompatPatch<T extends { compat?: ModelCompatConfig }>(
  model: T,
  patch: Partial<ModelCompatConfig> & Record<string, unknown>,
): T {
  const nextCompat = { ...model.compat, ...patch } as ModelCompatConfig;
  const currentCompat = model.compat as (Record<string, unknown> & ModelCompatConfig) | undefined;
  if (
    model.compat &&
    Object.entries(patch).every(([key, value]) => currentCompat?.[key] === value)
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

export function resolveArrayToolParameterItems(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): ModelCompatConfig["arrayToolParameterItems"] | undefined {
  const mode = extractModelCompat(modelOrCompat)?.arrayToolParameterItems;
  return mode === "permissive" || mode === "string" || mode === "omit" ? mode : undefined;
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

export function shouldOmitEmptyArrayItems(
  modelOrCompat: { compat?: unknown } | ModelCompatConfig | undefined,
): boolean {
  return extractModelCompat(modelOrCompat)?.omitEmptyArrayItems === true;
}

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
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

  const compat = extractModelCompat(model);
  const detectedCompatDefaults = baseUrl
    ? detectOpenAICompletionsCompat(model).defaults
    : undefined;
  const shouldForceArrayToolParameterItems = Boolean(
    detectedCompatDefaults &&
    detectedCompatDefaults.arrayToolParameterItems !== "permissive" &&
    compat?.arrayToolParameterItems === undefined,
  );
  const needsForce = Boolean(
    detectedCompatDefaults &&
    (!detectedCompatDefaults.supportsDeveloperRole ||
      !detectedCompatDefaults.supportsUsageInStreaming ||
      !detectedCompatDefaults.supportsStrictMode ||
      shouldForceArrayToolParameterItems),
  );
  if (!needsForce) {
    return model;
  }
  const forcedDeveloperRole = compat?.supportsDeveloperRole === true;
  const hasStreamingUsageOverride = compat?.supportsUsageInStreaming !== undefined;
  const hasArrayToolParameterItemsOverride = compat?.arrayToolParameterItems !== undefined;
  const targetStrictMode = compat?.supportsStrictMode ?? detectedCompatDefaults?.supportsStrictMode;
  if (
    compat?.supportsDeveloperRole !== undefined &&
    hasStreamingUsageOverride &&
    compat?.supportsStrictMode !== undefined &&
    (hasArrayToolParameterItemsOverride || !shouldForceArrayToolParameterItems)
  ) {
    return model;
  }

  return {
    ...model,
    compat: compat
      ? {
          ...compat,
          supportsDeveloperRole: forcedDeveloperRole || false,
          ...(hasStreamingUsageOverride
            ? {}
            : {
                supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false,
              }),
          supportsStrictMode: targetStrictMode,
          ...(shouldForceArrayToolParameterItems
            ? { arrayToolParameterItems: detectedCompatDefaults?.arrayToolParameterItems }
            : {}),
        }
      : {
          supportsDeveloperRole: false,
          supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false,
          supportsStrictMode: detectedCompatDefaults?.supportsStrictMode ?? false,
          ...(shouldForceArrayToolParameterItems
            ? { arrayToolParameterItems: detectedCompatDefaults?.arrayToolParameterItems }
            : {}),
        },
  } as typeof model;
}
