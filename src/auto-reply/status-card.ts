import fs from "node:fs";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import type { SessionEntry, SessionScope } from "../config/sessions/types.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  estimateUsageCost,
  formatTokenCount as formatTokenCountShared,
  formatUsd,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import { VERSION } from "../version.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./thinking.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentConfig = Partial<AgentDefaults> & {
  model?: AgentDefaults["model"] | string;
};

type QueueStatus = {
  mode?: string;
  depth?: number;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: string;
  showDetails?: boolean;
};

type StatusArgs = {
  config?: OpenClawConfig;
  agent: AgentConfig;
  agentId?: string;
  runtimeContextTokens?: number;
  explicitConfiguredContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  sessionStorePath?: string;
  groupActivation?: "mention" | "always";
  resolvedThink?: ThinkLevel;
  resolvedFast?: boolean;
  resolvedVerbose?: VerboseLevel;
  resolvedReasoning?: ReasoningLevel;
  resolvedElevated?: ElevatedLevel;
  modelAuth?: string;
  activeModelAuth?: string;
  usageLine?: string;
  timeLine?: string;
  queue?: QueueStatus;
  mediaDecisions?: ReadonlyArray<MediaUnderstandingDecision>;
  subagentsLine?: string;
  taskLine?: string;
  includeTranscriptUsage?: boolean;
  now?: number;
};

export const formatTokenCount = formatTokenCountShared;

function parseModelRef(value?: string | null): { provider: string; model: string; label: string } {
  const raw = value?.trim();
  if (!raw) {
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      label: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
    };
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) {
    return {
      provider: DEFAULT_PROVIDER,
      model: raw,
      label: `${DEFAULT_PROVIDER}/${raw}`,
    };
  }
  const provider = raw.slice(0, slashIndex).trim();
  const model = raw.slice(slashIndex + 1).trim();
  return {
    provider: provider || DEFAULT_PROVIDER,
    model: model || DEFAULT_MODEL,
    label: `${provider || DEFAULT_PROVIDER}/${model || DEFAULT_MODEL}`,
  };
}

function resolvePrimaryModelLabel(model: AgentConfig["model"]): string | undefined {
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  const primary = model?.primary;
  return typeof primary === "string" ? primary.trim() || undefined : undefined;
}

function resolveRuntimeLabel(args: Pick<StatusArgs, "agent">): string {
  const sandboxMode = args.agent?.sandbox?.mode ?? "off";
  if (sandboxMode === "off") {
    return "direct";
  }
  if (sandboxMode === "all") {
    return "docker/all";
  }
  return `direct/${sandboxMode}`;
}

const formatTokens = (total: number | null | undefined, contextTokens: number | null) => {
  const ctx = contextTokens ?? null;
  if (total == null) {
    const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
    return `?/${ctxLabel}`;
  }
  const pct = ctx ? Math.min(999, Math.round((total / ctx) * 100)) : null;
  const totalLabel = formatTokenCount(total);
  const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
  return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};

const formatQueueDetails = (queue?: QueueStatus) => {
  if (!queue) {
    return "";
  }
  const depth = typeof queue.depth === "number" ? `depth ${queue.depth}` : null;
  if (!queue.showDetails) {
    return depth ? ` (${depth})` : "";
  }
  const detailParts: string[] = [];
  if (depth) {
    detailParts.push(depth);
  }
  if (typeof queue.debounceMs === "number") {
    const ms = Math.max(0, Math.round(queue.debounceMs));
    const label =
      ms >= 1000 ? `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)}s` : `${ms}ms`;
    detailParts.push(`debounce ${label}`);
  }
  if (typeof queue.cap === "number") {
    detailParts.push(`cap ${queue.cap}`);
  }
  if (queue.dropPolicy) {
    detailParts.push(`drop ${queue.dropPolicy}`);
  }
  return detailParts.length ? ` (${detailParts.join(" · ")})` : "";
};

const readUsageFromSessionLog = (
  sessionId?: string,
  sessionEntry?: SessionEntry,
  agentId?: string,
  sessionKey?: string,
  storePath?: string,
):
  | {
      input: number;
      output: number;
      promptTokens: number;
      total: number;
      model?: string;
    }
  | undefined => {
  if (!sessionId) {
    return undefined;
  }
  let logPath: string;
  try {
    const resolvedAgentId =
      agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
    logPath = resolveSessionFilePath(
      sessionId,
      sessionEntry,
      resolveSessionFilePathOptions({ agentId: resolvedAgentId, storePath }),
    );
  } catch {
    return undefined;
  }
  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  try {
    const tailBytes = 8192;
    const stat = fs.statSync(logPath);
    const offset = Math.max(0, stat.size - tailBytes);
    const buf = Buffer.alloc(Math.min(tailBytes, stat.size));
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    const tail = buf.toString("utf-8");
    const lines = (offset > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail).split(/\n+/);

    let model: string | undefined;
    let lastUsage: UsageLike | undefined;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: {
            usage?: UsageLike;
            model?: string;
          };
          usage?: UsageLike;
          model?: string;
        };
        const usage = normalizeUsage(parsed.message?.usage ?? parsed.usage);
        if (usage) {
          lastUsage = usage;
        }
        model = parsed.message?.model ?? parsed.model ?? model;
      } catch {}
    }

    if (!lastUsage) {
      return undefined;
    }
    const input = lastUsage.input ?? 0;
    const output = lastUsage.output ?? 0;
    const promptTokens = derivePromptTokens(lastUsage) ?? lastUsage.total ?? input + output;
    const total = lastUsage.total ?? promptTokens + output;
    if (promptTokens === 0 && total === 0) {
      return undefined;
    }
    return { input, output, promptTokens, total, model };
  } catch {
    return undefined;
  }
};

const formatUsagePair = (input?: number | null, output?: number | null) => {
  if (input == null && output == null) {
    return null;
  }
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  return `🧮 Tokens: ${inputLabel} in / ${outputLabel} out`;
};

const formatCacheLine = (
  input?: number | null,
  cacheRead?: number | null,
  cacheWrite?: number | null,
) => {
  if (!cacheRead && !cacheWrite) {
    return null;
  }
  if (
    (typeof cacheRead !== "number" || cacheRead <= 0) &&
    (typeof cacheWrite !== "number" || cacheWrite <= 0)
  ) {
    return null;
  }

  const cachedLabel = typeof cacheRead === "number" ? formatTokenCount(cacheRead) : "0";
  const newLabel = typeof cacheWrite === "number" ? formatTokenCount(cacheWrite) : "0";
  const totalInput =
    (typeof cacheRead === "number" ? cacheRead : 0) +
    (typeof cacheWrite === "number" ? cacheWrite : 0) +
    (typeof input === "number" ? input : 0);
  const hitRate =
    totalInput > 0 && typeof cacheRead === "number"
      ? Math.round((cacheRead / totalInput) * 100)
      : 0;

  return `🗄️ Cache: ${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
};

const formatMediaUnderstandingLine = (decisions?: ReadonlyArray<MediaUnderstandingDecision>) => {
  if (!decisions || decisions.length === 0) {
    return null;
  }
  const parts = decisions
    .map((decision) => {
      const count = decision.attachments.length;
      const countLabel = count > 1 ? ` x${count}` : "";
      if (decision.outcome === "success") {
        const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
        const provider = chosen?.provider?.trim();
        const model = chosen?.model?.trim();
        const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : null;
        return `${decision.capability}${countLabel} ok${modelLabel ? ` (${modelLabel})` : ""}`;
      }
      if (decision.outcome === "no-attachment") {
        return `${decision.capability} none`;
      }
      if (decision.outcome === "disabled") {
        return `${decision.capability} off`;
      }
      if (decision.outcome === "scope-deny") {
        return `${decision.capability} denied`;
      }
      if (decision.outcome === "skipped") {
        const reason = decision.attachments
          .flatMap((entry) => entry.attempts.map((attempt) => attempt.reason).filter(Boolean))
          .find(Boolean);
        const shortReason = reason ? reason.split(":")[0]?.trim() : undefined;
        return `${decision.capability} skipped${shortReason ? ` (${shortReason})` : ""}`;
      }
      return null;
    })
    .filter((part): part is string => part != null);
  if (parts.every((part) => part.endsWith(" none"))) {
    return null;
  }
  return `📎 Media: ${parts.join(" · ")}`;
};

export function buildStatusMessage(args: StatusArgs): string {
  const now = args.now ?? Date.now();
  const entry = args.sessionEntry;
  const selectedRef = parseModelRef(
    entry?.providerOverride && entry?.modelOverride
      ? `${entry.providerOverride}/${entry.modelOverride}`
      : entry?.modelOverride
        ? `${DEFAULT_PROVIDER}/${entry.modelOverride}`
        : resolvePrimaryModelLabel(args.agent.model),
  );
  const runtimeRef = parseModelRef(
    entry?.modelProvider && entry?.model
      ? `${entry.modelProvider}/${entry.model}`
      : entry?.model
        ? entry.model
        : selectedRef.label,
  );
  const activeRef = runtimeRef;
  const activeDiffers =
    activeRef.provider !== selectedRef.provider || activeRef.model !== selectedRef.model;

  let inputTokens = entry?.inputTokens;
  let outputTokens = entry?.outputTokens;
  let cacheRead = entry?.cacheRead;
  let cacheWrite = entry?.cacheWrite;
  let totalTokens = entry?.totalTokens ?? (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);

  if (args.includeTranscriptUsage) {
    const logUsage = readUsageFromSessionLog(
      entry?.sessionId,
      entry,
      args.agentId,
      args.sessionKey,
      args.sessionStorePath,
    );
    if (logUsage) {
      const candidate = logUsage.promptTokens || logUsage.total;
      if (!totalTokens || totalTokens === 0 || candidate > totalTokens) {
        totalTokens = candidate;
      }
      if (!inputTokens || inputTokens === 0) {
        inputTokens = logUsage.input;
      }
      if (!outputTokens || outputTokens === 0) {
        outputTokens = logUsage.output;
      }
    }
  }

  const persistedContextTokens =
    typeof entry?.contextTokens === "number" && entry.contextTokens > 0
      ? entry.contextTokens
      : undefined;
  const runtimeContextTokens =
    typeof args.runtimeContextTokens === "number" && args.runtimeContextTokens > 0
      ? args.runtimeContextTokens
      : undefined;
  const configuredContextTokens =
    typeof args.explicitConfiguredContextTokens === "number" &&
    args.explicitConfiguredContextTokens > 0
      ? args.explicitConfiguredContextTokens
      : undefined;
  const agentContextTokens =
    typeof args.agent.contextTokens === "number" && args.agent.contextTokens > 0
      ? args.agent.contextTokens
      : undefined;
  const contextTokens =
    runtimeContextTokens ??
    persistedContextTokens ??
    configuredContextTokens ??
    agentContextTokens ??
    DEFAULT_CONTEXT_TOKENS;

  const thinkLevel =
    args.resolvedThink ?? args.sessionEntry?.thinkingLevel ?? args.agent?.thinkingDefault ?? "off";
  const verboseLevel =
    args.resolvedVerbose ?? args.sessionEntry?.verboseLevel ?? args.agent?.verboseDefault ?? "off";
  const fastMode = args.resolvedFast ?? args.sessionEntry?.fastMode ?? false;
  const reasoningLevel = args.resolvedReasoning ?? args.sessionEntry?.reasoningLevel ?? "off";
  const elevatedLevel =
    args.resolvedElevated ??
    args.sessionEntry?.elevatedLevel ??
    args.agent?.elevatedDefault ??
    "on";

  const updatedAt = entry?.updatedAt;
  const sessionLine = [
    `Session: ${args.sessionKey ?? "unknown"}`,
    typeof updatedAt === "number" ? `updated ${formatTimeAgo(now - updatedAt)}` : "no activity",
  ]
    .filter(Boolean)
    .join(" • ");

  const isGroupSession =
    entry?.chatType === "group" ||
    entry?.chatType === "channel" ||
    Boolean(args.sessionKey?.includes(":group:")) ||
    Boolean(args.sessionKey?.includes(":channel:"));
  const groupActivationValue = isGroupSession
    ? (args.groupActivation ?? entry?.groupActivation ?? "mention")
    : undefined;

  const contextLine = [
    `Context: ${formatTokens(totalTokens, contextTokens ?? null)}`,
    `🧹 Compactions: ${entry?.compactionCount ?? 0}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const queueMode = args.queue?.mode ?? "unknown";
  const queueDetails = formatQueueDetails(args.queue);
  const verboseLabel =
    verboseLevel === "full" ? "verbose:full" : verboseLevel === "on" ? "verbose" : null;
  const elevatedLabel =
    elevatedLevel && elevatedLevel !== "off"
      ? elevatedLevel === "on"
        ? "elevated"
        : `elevated:${elevatedLevel}`
      : null;
  const optionParts = [
    `Runtime: ${resolveRuntimeLabel(args)}`,
    `Think: ${thinkLevel}`,
    fastMode ? "Fast: on" : null,
    verboseLabel,
    reasoningLevel !== "off" ? `Reasoning: ${reasoningLevel}` : null,
    elevatedLabel,
  ];
  const optionsLine = optionParts.filter(Boolean).join(" · ");
  const activationParts = [
    groupActivationValue ? `👥 Activation: ${groupActivationValue}` : null,
    `🪢 Queue: ${queueMode}${queueDetails}`,
  ];
  const activationLine = activationParts.filter(Boolean).join(" · ");

  const showCost = (args.activeModelAuth ?? args.modelAuth)?.trim() === "api-key";
  const costConfig = showCost
    ? resolveModelCostConfig({
        provider: activeRef.provider,
        model: activeRef.model,
        config: args.config,
        allowPluginNormalization: false,
      })
    : undefined;
  const hasUsage = typeof inputTokens === "number" || typeof outputTokens === "number";
  const cost =
    showCost && hasUsage
      ? estimateUsageCost({
          usage: {
            input: inputTokens ?? undefined,
            output: outputTokens ?? undefined,
          },
          cost: costConfig,
        })
      : undefined;
  const costLabel = showCost && hasUsage ? formatUsd(cost) : undefined;

  const selectedAuthLabel = args.modelAuth ? ` · 🔑 ${args.modelAuth}` : "";
  const showFallbackAuth = Boolean(args.activeModelAuth) && args.activeModelAuth !== args.modelAuth;
  const modelLine = `🧠 Model: ${selectedRef.label}${selectedAuthLabel}`;
  const fallbackLine = activeDiffers
    ? `↪️ Fallback: ${activeRef.label}${showFallbackAuth ? ` · 🔑 ${args.activeModelAuth}` : ""}`
    : null;
  const versionLine = `🦞 OpenClaw ${VERSION}`;
  const usagePair = formatUsagePair(inputTokens, outputTokens);
  const cacheLine = formatCacheLine(inputTokens, cacheRead, cacheWrite);
  const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
  const usageCostLine =
    usagePair && costLine ? `${usagePair} · ${costLine}` : (usagePair ?? costLine);
  const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);

  return [
    versionLine,
    args.timeLine,
    modelLine,
    fallbackLine,
    usageCostLine,
    cacheLine,
    `📚 ${contextLine}`,
    mediaLine,
    args.usageLine,
    `🧵 ${sessionLine}`,
    args.subagentsLine,
    args.taskLine,
    `⚙️ ${optionsLine}`,
    activationLine,
  ]
    .filter(Boolean)
    .join("\n");
}
