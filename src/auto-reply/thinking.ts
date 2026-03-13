import { getRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import type { ModelCompatConfig } from "../config/types.models.js";

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
  return source?.config ?? getRuntimeConfigSnapshot();
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

  for (const entry of source?.catalog ?? []) {
    add(entry.provider, entry.id, entry.compat?.supportsXHighThinking);
  }

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

  return [...out.values()];
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.2",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.1-codex",
  "github-copilot/gpt-5.2-codex",
  "github-copilot/gpt-5.2",
] as const;

const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter(
    (entry): entry is string => Boolean(entry),
  ),
);

function listSupportedXHighModelRefs(source?: ThinkingSupportSource): string[] {
  const explicit = collectExplicitXHighRefs(source);
  const explicitMap = new Map(explicit.map((entry) => [entry.ref.toLowerCase(), entry] as const));
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const ref of XHIGH_MODEL_REFS) {
    const key = ref.toLowerCase();
    if (explicitMap.get(key)?.supported === false) {
      continue;
    }
    refs.push(ref);
    seen.add(key);
  }

  for (const entry of explicit) {
    const key = entry.ref.toLowerCase();
    if (!entry.supported || seen.has(key)) {
      continue;
    }
    refs.push(entry.ref);
    seen.add(key);
  }

  return refs;
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
    return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
  }
  return XHIGH_MODEL_IDS.has(modelKey);
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
  if (isBinaryThinkingProvider(provider)) {
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
    return "unknown model";
  }
  if (refs.length === 1) {
    return refs[0];
  }
  if (refs.length === 2) {
    return `${refs[0]} or ${refs[1]}`;
  }
  return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const modelLower = params.model.trim().toLowerCase();
  const isAnthropicFamilyModel =
    normalizedProvider === "anthropic" ||
    normalizedProvider === "amazon-bedrock" ||
    modelLower.includes("anthropic/") ||
    modelLower.includes(".anthropic.");
  if (isAnthropicFamilyModel && CLAUDE_46_MODEL_RE.test(modelLower)) {
    return "adaptive";
  }
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
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
