/**
 * Browser-safe thinking level utilities.
 * No Node.js or plugin-runtime dependencies — safe to import in Vite browser bundles.
 */

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
};

/** Optional provider query callbacks for plugin-backed thinking policy resolution. */
export type ThinkingProviderQueries = {
  resolveBinaryThinking?: (params: {
    provider: string;
    context: { provider: string; modelId: string };
  }) => boolean | undefined;
  resolveXHighThinking?: (params: {
    provider: string;
    context: { provider: string; modelId: string };
  }) => boolean | undefined;
  resolveDefaultThinkingLevel?: (params: {
    provider: string;
    context: { provider: string; modelId: string; reasoning?: boolean };
  }) => ThinkLevel | undefined;
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

export function isBinaryThinkingProvider(
  provider?: string | null,
  model?: string | null,
  queries?: ThinkingProviderQueries,
): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = queries?.resolveBinaryThinking?.({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: model?.trim() ?? "",
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

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
  queries?: ThinkingProviderQueries,
): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = normalizeProviderId(provider);
  if (providerKey) {
    const pluginDecision = queries?.resolveXHighThinking?.({
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
  queries?: ThinkingProviderQueries,
): ThinkLevel[] {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (supportsXHighThinking(provider, model, queries)) {
    levels.push("xhigh");
  }
  levels.push("adaptive");
  return levels;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  queries?: ThinkingProviderQueries,
): string[] {
  if (isBinaryThinkingProvider(provider, model, queries)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model, queries);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  queries?: ThinkingProviderQueries,
): string {
  return listThinkingLevelLabels(provider, model, queries).join(separator);
}

export function formatXHighModelHint(): string {
  return "provider models that advertise xhigh reasoning";
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
  queries?: ThinkingProviderQueries;
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const modelLower = params.model.trim().toLowerCase();
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const pluginDecision = params.queries?.resolveDefaultThinkingLevel?.({
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

export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

export function normalizeNoticeLevel(raw?: string | null): NoticeLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

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
