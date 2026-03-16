import type { OpenClawConfig } from "../config/types.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking,
} from "../plugins/provider-runtime.js";

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
export type VerboseLevel = "off" | "on" | "full";
export type NoticeLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";
export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  compat?: Pick<ModelCompatConfig, "supportsXHighThinking">;
};
export type ThinkingSupportSource = {
  config?: Pick<OpenClawConfig, "models"> | null;
  catalog?: ThinkingCatalogEntry[] | null;
};

const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

function normalizeModelId(model?: string | null): string {
  return model?.trim().toLowerCase() ?? "";
}

function normalizeModelRef(provider?: string | null, model?: string | null): string {
  const providerKey = normalizeProviderId(provider);
  const modelKey = normalizeModelId(model);
  return providerKey && modelKey ? `${providerKey}/${modelKey}` : "";
}

function resolveThinkingSupportConfig(
  source?: ThinkingSupportSource,
): Pick<OpenClawConfig, "models"> | null {
  // Keep this module browser-safe: the Control UI imports it directly, so
  // callers must pass config explicitly instead of pulling runtime config here.
  return source?.config ?? null;
}

function resolveCatalogXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  const ref = normalizeModelRef(provider, model);
  if (!ref) {
    return undefined;
  }
  const entry = source?.catalog?.find(
    (candidate) => normalizeModelRef(candidate.provider, candidate.id) === ref,
  );
  return typeof entry?.compat?.supportsXHighThinking === "boolean"
    ? entry.compat.supportsXHighThinking
    : undefined;
}

function resolveConfigXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  const providerKey = normalizeProviderId(provider);
  const modelKey = normalizeModelId(model);
  if (!providerKey || !modelKey) {
    return undefined;
  }

  const config = resolveThinkingSupportConfig(source);
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }

  for (const [configuredProviderId, configuredProvider] of Object.entries(providers)) {
    if (normalizeProviderId(configuredProviderId) !== providerKey) {
      continue;
    }
    if (!configuredProvider || typeof configuredProvider !== "object") {
      continue;
    }
    const configuredModels = (configuredProvider as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }
    for (const configuredModel of configuredModels) {
      if (!configuredModel || typeof configuredModel !== "object") {
        continue;
      }
      const configuredModelId = (configuredModel as { id?: unknown }).id;
      if (
        typeof configuredModelId !== "string" ||
        normalizeModelId(configuredModelId) !== modelKey
      ) {
        continue;
      }
      const compat = (configuredModel as { compat?: { supportsXHighThinking?: unknown } }).compat;
      if (typeof compat?.supportsXHighThinking === "boolean") {
        return compat.supportsXHighThinking;
      }
    }
  }

  return undefined;
}

function resolveExplicitXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  return (
    resolveCatalogXHighOverride(provider, model, source) ??
    resolveConfigXHighOverride(provider, model, source)
  );
}

function collectExplicitXHighRefs(
  source?: ThinkingSupportSource,
): Array<{ ref: string; supported: boolean }> {
  const out = new Map<string, { ref: string; supported: boolean }>();

  const add = (provider?: string | null, model?: string | null, supported?: unknown) => {
    if (typeof supported !== "boolean") {
      return;
    }
    const ref = normalizeModelRef(provider, model);
    if (!ref) {
      return;
    }
    out.set(ref, { ref, supported });
  };

  const config = resolveThinkingSupportConfig(source);
  const providers = config?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const configuredModels =
        providerConfig && typeof providerConfig === "object"
          ? (providerConfig as { models?: unknown }).models
          : undefined;
      if (!Array.isArray(configuredModels)) {
        continue;
      }
      for (const configuredModel of configuredModels) {
        if (!configuredModel || typeof configuredModel !== "object") {
          continue;
        }
        const modelId = (configuredModel as { id?: unknown }).id;
        const compat = (configuredModel as { compat?: { supportsXHighThinking?: unknown } }).compat;
        add(
          providerId,
          typeof modelId === "string" ? modelId : undefined,
          compat?.supportsXHighThinking,
        );
      }
    }
  }

  // Match resolveExplicitXHighOverride(): catalog entries override config for the same ref.
  for (const entry of source?.catalog ?? []) {
    add(entry.provider, entry.id, entry.compat?.supportsXHighThinking);
  }

  return [...out.values()];
}

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeModelId(model);
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = resolveProviderBinaryThinking({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: normalizedModel,
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

function listSupportedXHighModelRefs(source?: ThinkingSupportSource): string[] {
  const explicit = collectExplicitXHighRefs(source);
  return explicit.filter((entry) => entry.supported).map((entry) => entry.ref);
}

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (["off"].includes(key)) {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (
    ["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest", "max"].includes(key)
  ) {
    return "high";
  }
  if (["think"].includes(key)) {
    return "minimal";
  }
  return undefined;
}

export function supportsXHighThinking(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean {
  const modelKey = normalizeModelId(model);
  if (!modelKey) {
    return false;
  }
  const explicit = resolveExplicitXHighOverride(provider, model, source);
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const providerKey = normalizeProviderId(provider);
  if (providerKey) {
    const pluginDecision = resolveProviderXHighThinking({
      provider: providerKey,
      context: {
        provider: providerKey,
        modelId: modelKey,
      },
    });
    if (typeof pluginDecision === "boolean") {
      return pluginDecision;
    }
  }
  return false;
}

export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): ThinkLevel[] {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (supportsXHighThinking(provider, model, source)) {
    levels.push("xhigh");
  }
  levels.push("adaptive");
  return levels;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model, source);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  source?: ThinkingSupportSource,
): string {
  return listThinkingLevelLabels(provider, model, source).join(separator);
}

export function formatXHighModelHint(source?: ThinkingSupportSource): string {
  const refs = listSupportedXHighModelRefs(source);
  if (refs.length === 0) {
    return "provider models that advertise xhigh reasoning";
  }
  if (refs.length === 1) {
    return `provider models that advertise xhigh reasoning, including ${refs[0]}`;
  }
  if (refs.length === 2) {
    return `provider models that advertise xhigh reasoning, including ${refs[0]} or ${refs[1]}`;
  }
  return `provider models that advertise xhigh reasoning, including ${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const modelLower = params.model.trim().toLowerCase();
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const pluginDecision = resolveProviderDefaultThinkingLevel({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: params.model,
      reasoning: candidate?.reasoning,
    },
  });
  if (pluginDecision) {
    return pluginDecision;
  }

  if (normalizedProvider === "amazon-bedrock" && CLAUDE_46_MODEL_RE.test(modelLower)) {
    return "adaptive";
  }
  if (candidate?.reasoning) {
    return "low";
  }
  return "off";
}

type OnOffFullLevel = "off" | "on" | "full";

function normalizeOnOffFullLevel(raw?: string | null): OnOffFullLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "all", "everything"].includes(key)) {
    return "full";
  }
  if (["on", "minimal", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

// Normalize system notice flags used to toggle system notifications.
export function normalizeNoticeLevel(raw?: string | null): NoticeLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

// Normalize response-usage display modes used to toggle per-response usage footers.
export function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "disable", "disabled"].includes(key)) {
    return "off";
  }
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(key)) {
    return "tokens";
  }
  if (["tokens", "token", "tok", "minimal", "min"].includes(key)) {
    return "tokens";
  }
  if (["full", "session"].includes(key)) {
    return "full";
  }
  return undefined;
}

export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

// Normalize fast-mode flags used to toggle low-latency model behavior.
export function normalizeFastMode(raw?: string | boolean | null): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!raw) {
    return undefined;
  }
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "disable", "disabled", "normal"].includes(key)) {
    return false;
  }
  if (["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(key)) {
    return true;
  }
  return undefined;
}

// Normalize elevated flags used to toggle elevated bash permissions.
export function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "auto", "auto-approve", "autoapprove"].includes(key)) {
    return "full";
  }
  if (["ask", "prompt", "approval", "approve"].includes(key)) {
    return "ask";
  }
  if (["on", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

export function resolveElevatedMode(level?: ElevatedLevel | null): ElevatedMode {
  if (!level || level === "off") {
    return "off";
  }
  if (level === "full") {
    return "full";
  }
  return "ask";
}

// Normalize reasoning visibility flags used to toggle reasoning exposure.
export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "hide", "hidden", "disable", "disabled"].includes(key)) {
    return "off";
  }
  if (["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(key)) {
    return "on";
  }
  if (["stream", "streaming", "draft", "live"].includes(key)) {
    return "stream";
  }
  return undefined;
}
