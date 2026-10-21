import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "../../agents/embedded-agent-runner/types.js";
import { resolveModelAuthModeAsync } from "../../agents/model-auth.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import {
  resolveSessionPluginStatusLines,
  resolveSessionPluginTraceLines,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readLatestSessionUsageFromTranscriptAsync } from "../../gateway/session-transcript-usage.js";
import { formatTokenCount } from "../../utils/token-format.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import { INBOUND_CONTEXT_MARKER } from "./inbound-context-marker.js";
import type { FollowupRun } from "./queue.js";

type TraceUsageView = Pick<
  NormalizedUsage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "total"
>;

const TRACE_USAGE_FIELDS = [
  ["input", "⬇️"],
  ["output", "⬆️"],
  ["cacheRead", "♻️"],
  ["cacheWrite", "🆕"],
  ["total", "🔢"],
] as const;

/** Builds the same authorized diagnostic supplement for immediate and queued replies. */
export async function buildReplyDiagnosticsPayload(params: {
  activeSessionEntry: SessionEntry | undefined;
  followupRun: Pick<FollowupRun, "run">;
  accounting: {
    runResult: EmbeddedAgentRunResult;
    providerUsed: string;
    modelUsed: string;
    contextTokensUsed: number;
    promptTokens?: number;
  };
  cfg?: OpenClawConfig;
  storePath?: string;
  userText?: string;
  resolvedVerboseLevel?: VerboseLevel;
  resolvedBlockStreamingBreak?: string;
  preflightCompactionApplied?: boolean;
}): Promise<ReplyPayload | undefined> {
  const {
    activeSessionEntry,
    followupRun,
    accounting,
    cfg,
    storePath,
    userText,
    resolvedVerboseLevel,
    resolvedBlockStreamingBreak,
    preflightCompactionApplied,
  } = params;
  const { runResult, providerUsed, modelUsed, contextTokensUsed, promptTokens } = accounting;
  // Explicit turn choices win over the terminal owner's session preferences.
  const verboseEnabled =
    (normalizeVerboseLevel(
      followupRun.run.verboseLevelOverride ??
        activeSessionEntry?.verboseLevel ??
        resolvedVerboseLevel ??
        followupRun.run.verboseLevel,
    ) ?? "off") !== "off";
  const traceAuthorized = followupRun.run.traceAuthorized === true;
  const traceLevel = followupRun.run.traceLevelOverride ?? activeSessionEntry?.traceLevel;
  const traceEnabled = traceAuthorized && (traceLevel === "on" || traceLevel === "raw");
  const thinkingClamp = runResult.meta?.requestShaping?.thinkingClamp;
  if (!verboseEnabled && !traceEnabled) {
    return undefined;
  }
  const lines = [
    ...(thinkingClamp ? [thinkingClamp] : []),
    ...(verboseEnabled ? resolveSessionPluginStatusLines(activeSessionEntry) : []),
    ...(traceEnabled ? resolveSessionPluginTraceLines(activeSessionEntry) : []),
  ];
  let diagnosticsPayload: ReplyPayload | undefined = lines.length
    ? { text: lines.join("\n") }
    : undefined;
  if (traceAuthorized && traceLevel === "raw") {
    const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
    const rawUserText = isHookBlockedRun
      ? runResult.meta?.finalPromptText
      : (runResult.meta?.finalPromptText ?? userText);
    const rawAssistantText = isHookBlockedRun
      ? undefined
      : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
    const executionTrace = runResult.meta?.executionTrace;
    const requestShaping = {
      authMode:
        runResult.meta?.requestShaping?.authMode ??
        (cfg?.models?.providers && providerUsed in cfg.models.providers
          ? await resolveModelAuthModeAsync(providerUsed, cfg, undefined, {
              workspaceDir: followupRun.run.workspaceDir,
            })
          : undefined),
      thinking:
        runResult.meta?.requestShaping?.thinking ??
        normalizeOptionalString(followupRun.run.thinkLevel),
      reasoning:
        runResult.meta?.requestShaping?.reasoning ??
        normalizeOptionalString(followupRun.run.reasoningLevel),
      verbose:
        runResult.meta?.requestShaping?.verbose ?? normalizeOptionalString(resolvedVerboseLevel),
      trace:
        followupRun.run.traceLevelOverride ??
        runResult.meta?.requestShaping?.trace ??
        normalizeOptionalString(activeSessionEntry?.traceLevel),
      fallbackEligible:
        runResult.meta?.requestShaping?.fallbackEligible ??
        resolveModelFallbackOptions(followupRun.run, cfg ?? {}).modelFallbackAvailability.kind ===
          "active",
      blockStreaming:
        runResult.meta?.requestShaping?.blockStreaming ??
        normalizeOptionalString(resolvedBlockStreamingBreak),
    };
    const promptSegments = runResult.meta?.promptSegments ?? derivePromptSegments(rawUserText);
    const toolSummary = runResult.meta?.toolSummary;
    const completion =
      runResult.meta?.completion ??
      (runResult.meta?.stopReason
        ? {
            stopReason: runResult.meta.stopReason,
            finishReason: runResult.meta.stopReason,
            ...(runResult.meta.stopReason.toLowerCase().includes("refusal")
              ? { refusal: true }
              : {}),
          }
        : undefined);
    const contextManagement = runResult.meta?.contextManagement;
    let sessionUsage: TraceUsageView | undefined;
    const sessionId = normalizeOptionalString(
      runResult.meta?.agentMeta?.sessionId ?? followupRun.run.sessionId,
    );
    if (sessionId) {
      try {
        const artifactFile = followupRun.run.sessionFile?.trim();
        const useArtifactFile = Boolean(
          artifactFile && path.isAbsolute(artifactFile) && artifactFile.endsWith(".jsonl"),
        );
        const usage = await readLatestSessionUsageFromTranscriptAsync({
          agentId: followupRun.run.agentId,
          sessionId,
          sessionKey: useArtifactFile ? undefined : followupRun.run.sessionKey,
          storePath,
          sessionFile: followupRun.run.sessionFile,
        });
        if (usage) {
          sessionUsage = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            total: usage.totalTokens,
          };
        }
      } catch {
        // Session usage is an optional diagnostic; rendering must still complete.
      }
    }
    const usage = runResult.meta?.agentMeta?.usage;
    const lastTurnCompactions =
      contextManagement?.lastTurnCompactions ?? runResult.meta?.agentMeta?.compactionCount;
    const resolvedPromptTokens = deriveContextPromptTokens({
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      usage,
    });
    const requestContextBlock = formatRequestContextTraceBlock({
      provider: providerUsed,
      model: modelUsed,
      contextLimit: contextTokensUsed,
      promptTokens: resolvedPromptTokens,
    });
    const usageBlocks = [
      formatUsageTraceBlock("Usage (Session Total)", sessionUsage),
      formatUsageTraceBlock("Usage (Last Turn Total)", usage),
      requestContextBlock,
      formatExecutionResultTraceBlock(executionTrace),
      formatFallbackChainTraceBlock(executionTrace),
      formatKeyValueTraceBlock("Request Shaping", [
        ["provider", providerUsed],
        ["model", modelUsed],
        ["auth", requestShaping.authMode],
        ["thinking", requestShaping.thinking],
        ["reasoning", requestShaping.reasoning],
        ["verbose", requestShaping.verbose],
        ["trace", requestShaping.trace],
        ["fallbackEligible", requestShaping.fallbackEligible],
        ["blockStreaming", requestShaping.blockStreaming],
      ]),
      formatPromptSegmentsTraceBlock(promptSegments, rawUserText),
      formatToolSummaryTraceBlock(toolSummary),
      formatKeyValueTraceBlock("Completion", [
        ["finishReason", completion?.finishReason],
        ["stopReason", completion?.stopReason],
        ["refusal", completion?.refusal],
      ]),
      formatKeyValueTraceBlock("Context Management", [
        ["sessionCompactions", activeSessionEntry?.compactionCount],
        ["lastTurnCompactions", lastTurnCompactions],
        [
          "preflightCompactionApplied",
          contextManagement?.preflightCompactionApplied ??
            (preflightCompactionApplied || undefined),
        ],
        ["postCompactionContextInjected", contextManagement?.postCompactionContextInjected],
      ]),
    ].filter((value): value is string => Boolean(value));
    const thinking = normalizeOptionalString(requestShaping.thinking);
    const used = asPositiveFiniteNumber(resolvedPromptTokens);
    const limit = asPositiveFiniteNumber(contextTokensUsed);
    const summaryFields = [
      executionTrace?.winnerModel
        ? `winner=${executionTrace.winnerModel}${thinking ? ` 🧠 ${thinking}` : ""}`
        : undefined,
      executionTrace?.fallbackUsed !== undefined
        ? `fallback=${executionTrace.fallbackUsed ? "yes" : "no"}`
        : undefined,
      executionTrace?.attempts !== undefined
        ? `attempts=${executionTrace.attempts.length.toLocaleString()}`
        : undefined,
      completion?.stopReason ? `stop=${completion.stopReason}` : undefined,
      used !== undefined && limit !== undefined
        ? `prompt=${formatTokenCount(used)}/${formatTokenCount(limit)}`
        : undefined,
      ...TRACE_USAGE_FIELDS.map(([key, icon]) => {
        const value = usage?.[key];
        return value !== undefined && value > 0 ? `${icon} ${formatTokenCount(value)}` : undefined;
      }),
      toolSummary && toolSummary.calls > 0
        ? `tools=${toolSummary.calls.toLocaleString()}`
        : undefined,
      lastTurnCompactions !== undefined && lastTurnCompactions > 0
        ? `compactions=${lastTurnCompactions.toLocaleString()}`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    const rawTracePayload = {
      text: [
        ...usageBlocks,
        formatRawTraceBlock("Model Input (User Role)", rawUserText),
        formatRawTraceBlock("Model Output (Assistant Role)", rawAssistantText),
        summaryFields.length > 0 ? `Summary: ${summaryFields.join(" ")}` : undefined,
      ].join("\n\n\n"),
    };
    diagnosticsPayload = diagnosticsPayload
      ? { text: `${diagnosticsPayload.text}\n\n${rawTracePayload.text}` }
      : rawTracePayload;
  }
  return diagnosticsPayload ? { ...diagnosticsPayload, isStatusNotice: true } : undefined;
}

function formatRawTraceBlock(title: string, value: string | undefined): string {
  const body = value?.trim() ? value.replace(/^~~~/gm, "\\~~~") : "<empty>";
  return `🔎 ${title}:\n~~~text\n${body}\n~~~`;
}

function formatTraceUsageLine(label: string, value: number | undefined): string {
  const finite = asFiniteNumber(value);
  return `${label}=${finite !== undefined ? `${finite.toLocaleString()} tok (${formatTokenCount(finite)})` : "n/a"}`;
}

function formatUsageTraceBlock(
  title: string,
  usage: TraceUsageView | undefined,
): string | undefined {
  if (!usage || TRACE_USAGE_FIELDS.every(([key]) => asFiniteNumber(usage[key]) === undefined)) {
    return undefined;
  }
  return `🔎 ${title}:\n~~~text\n${TRACE_USAGE_FIELDS.map(([key]) =>
    formatTraceUsageLine(key, usage[key]),
  ).join("\n")}\n~~~`;
}

function formatTraceScalar(value: string | number | boolean | undefined): string | undefined {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : undefined;
  }
  return normalizeOptionalString(value);
}

function formatKeyValueTraceBlock(
  title: string,
  fields: Array<[string, string | number | boolean | undefined]>,
): string | undefined {
  const lines = fields.flatMap(([key, rawValue]) => {
    const value = formatTraceScalar(rawValue);
    return value ? [`${key}=${value}`] : [];
  });
  if (lines.length === 0) {
    return undefined;
  }
  return `🔎 ${title}:\n~~~text\n${lines.join("\n")}\n~~~`;
}

function formatExecutionResultTraceBlock(
  executionTrace: EmbeddedAgentRunMeta["executionTrace"],
): string | undefined {
  if (!executionTrace?.winnerProvider && !executionTrace?.winnerModel) {
    return undefined;
  }
  return formatKeyValueTraceBlock("Execution Result", [
    [
      "winner",
      executionTrace.winnerProvider && executionTrace.winnerModel
        ? `${executionTrace.winnerProvider}/${executionTrace.winnerModel}`
        : undefined,
    ],
    ["fallbackUsed", executionTrace.fallbackUsed],
    ["attempts", executionTrace.attempts?.length],
    ["runner", executionTrace.runner],
  ]);
}

function formatFallbackChainTraceBlock(
  executionTrace: EmbeddedAgentRunMeta["executionTrace"],
): string | undefined {
  const attempts = executionTrace?.attempts ?? [];
  if (attempts.length <= 1) {
    return undefined;
  }
  const body = attempts
    .map((attempt, index) =>
      [
        `${index + 1}. ${attempt.provider}/${attempt.model}`,
        `   result=${attempt.result}`,
        ...(attempt.reason ? [`   reason=${attempt.reason}`] : []),
        ...(attempt.stage ? [`   stage=${attempt.stage}`] : []),
        ...(attempt.elapsedMs !== undefined
          ? [`   elapsed=${(attempt.elapsedMs / 1000).toFixed(1)}s`]
          : []),
        ...(attempt.status !== undefined ? [`   status=${attempt.status}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
  return `🔎 Fallback Chain:\n~~~text\n${body}\n~~~`;
}

function resolveMetadataSegmentKey(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized === "conversation_info") {
    return "conversation_metadata";
  }
  if (normalized === "sender") {
    return "sender_metadata";
  }
  return normalized.endsWith("_metadata") ? normalized : `${normalized}_metadata`;
}

function derivePromptSegments(prompt: string | undefined): EmbeddedAgentRunMeta["promptSegments"] {
  const text = prompt ?? "";
  if (!text.trim()) {
    return undefined;
  }
  const lines = text.split("\n");
  const segments = new Map<string, number>();
  let userChars = 0;
  const addChars = (key: string, chars: number) => {
    segments.set(key, (segments.get(key) ?? 0) + chars);
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    let segmentKey: string | undefined;
    let end = index + 2;
    if (line === "Context:") {
      const tagLine = lines[index + 1] ?? "";
      const tagMatch = tagLine.trim().match(/^<([a-z0-9_:-]+)>$/i);
      if (tagMatch) {
        segmentKey = expectDefined(tagMatch[1], "tag match capture group 1");
        const closeTag = `</${tagMatch[1]}>`;
        while (end < lines.length && lines[end]?.trim() !== closeTag) {
          end += 1;
        }
      }
    } else if (line.trim().endsWith(INBOUND_CONTEXT_MARKER)) {
      const fence = lines[index + 1] ?? "";
      // Generated metadata blocks always use ```json fences (inbound-meta.ts,
      // channel-prompt-context.ts); other fence languages are user content and must
      // stay attributed to user_message.
      if (fence.trim() === "```json") {
        while (end < lines.length && !(lines[end] ?? "").startsWith("```")) {
          end += 1;
        }
        const headerWithoutMarker = line.trim().slice(0, -INBOUND_CONTEXT_MARKER.length).trim();
        segmentKey = resolveMetadataSegmentKey(headerWithoutMarker || "metadata");
      }
    }
    if (segmentKey && end < lines.length) {
      addChars(segmentKey, lines.slice(index, end + 1).join("\n").length);
      index = end + 1;
      while (index < lines.length && lines[index] === "") {
        index += 1;
      }
      continue;
    }
    if (line.trim()) {
      userChars += line.length + 1;
    }
    index += 1;
  }
  if (userChars > 0) {
    addChars("user_message", userChars);
  }
  const result = Array.from(segments.entries()).map(([key, chars]) => ({ key, chars }));
  return result.length > 0 ? result : undefined;
}

function formatPromptSegmentsTraceBlock(
  segments: EmbeddedAgentRunMeta["promptSegments"],
  totalPromptText: string | undefined,
): string | undefined {
  if (!segments?.length && !totalPromptText?.length) {
    return undefined;
  }
  const lines = (segments ?? []).map(
    (segment) => `${segment.key}=${segment.chars.toLocaleString()} chars`,
  );
  if (totalPromptText?.length) {
    lines.push(`totalPromptText=${totalPromptText.length.toLocaleString()} chars`);
  }
  return `🔎 Prompt Segments:\n~~~text\n${lines.join("\n")}\n~~~`;
}

function formatToolSummaryTraceBlock(
  toolSummary: EmbeddedAgentRunMeta["toolSummary"],
): string | undefined {
  if (!toolSummary || toolSummary.calls <= 0) {
    return undefined;
  }
  return formatKeyValueTraceBlock("Tool Summary", [
    ["calls", toolSummary.calls],
    ["tools", toolSummary.tools.length > 0 ? toolSummary.tools.join(", ") : undefined],
    ["failures", toolSummary.failures],
    ["totalToolTimeMs", toolSummary.totalToolTimeMs],
  ]);
}

function formatRequestContextTraceBlock(params: {
  provider?: string;
  model?: string;
  contextLimit?: number;
  promptTokens?: number;
}): string | undefined {
  const limit = asFiniteNumber(params.contextLimit);
  const used = asFiniteNumber(params.promptTokens);
  if (
    (limit === undefined || limit <= 0) &&
    (used === undefined || used <= 0) &&
    !params.provider &&
    !params.model
  ) {
    return undefined;
  }
  const headroom =
    limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined;
  const percent =
    limit !== undefined && limit > 0 && used !== undefined
      ? Math.round((used / limit) * 100)
      : undefined;
  return `🔎 Context Window (Last Model Request):\n~~~text\n${[
    `provider=${params.provider ?? "n/a"}`,
    `model=${params.model ?? "n/a"}`,
    formatTraceUsageLine("used", used),
    formatTraceUsageLine("limit", limit),
    `headroom=${headroom !== undefined ? `${headroom.toLocaleString()} tok (${formatTokenCount(headroom)})` : "n/a"}`,
    `usage=${percent !== undefined ? `${percent}%` : "n/a"}`,
  ].join("\n")}\n~~~`;
}
