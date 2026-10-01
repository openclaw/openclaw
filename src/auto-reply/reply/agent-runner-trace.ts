import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedAgentRunMeta } from "../../agents/embedded-agent-runner/types.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import { readLatestSessionUsageFromTranscriptAsync } from "../../gateway/session-transcript-usage.js";
import { formatTokenCount } from "../../utils/token-format.js";
import type { ReplyPayload } from "../types.js";
import { INBOUND_CONTEXT_MARKER } from "./inbound-context-marker.js";

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
        ...(typeof attempt.elapsedMs === "number"
          ? [`   elapsed=${(attempt.elapsedMs / 1000).toFixed(1)}s`]
          : []),
        ...(typeof attempt.status === "number" ? [`   status=${attempt.status}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
  return `🔎 Fallback Chain:\n~~~text\n${body}\n~~~`;
}

function toSnakeCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveMetadataSegmentKey(label: string): string {
  const normalized = toSnakeCase(label);
  if (normalized === "conversation_info") {
    return "conversation_metadata";
  }
  if (normalized === "sender") {
    return "sender_metadata";
  }
  return normalized.endsWith("_metadata") ? normalized : `${normalized}_metadata`;
}

export function derivePromptSegments(
  prompt: string | undefined,
): EmbeddedAgentRunMeta["promptSegments"] {
  const text = prompt ?? "";
  if (!text.trim()) {
    return undefined;
  }
  const lines = text.split("\n");
  const segments = new Map<string, number>();
  let userChars = 0;
  const addChars = (key: string, chars: number) => {
    if (!chars || chars <= 0) {
      return;
    }
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
  if (typeof totalPromptText === "string" && totalPromptText.length > 0) {
    lines.push(`totalPromptText=${totalPromptText.length.toLocaleString()} chars`);
  }
  return lines.length > 0 ? `🔎 Prompt Segments:\n~~~text\n${lines.join("\n")}\n~~~` : undefined;
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

export async function accumulateSessionUsageFromTranscript(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  sessionFile?: string;
}): Promise<TraceUsageView | undefined> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  try {
    const artifactFile = params.sessionFile?.trim();
    const useArtifactFile = Boolean(
      artifactFile && path.isAbsolute(artifactFile) && artifactFile.endsWith(".jsonl"),
    );
    const usage = await readLatestSessionUsageFromTranscriptAsync({
      agentId: params.agentId,
      sessionId,
      sessionKey: useArtifactFile ? undefined : params.sessionKey,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
    });
    if (!usage) {
      return undefined;
    }
    return {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.totalTokens,
    };
  } catch {
    return undefined;
  }
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
    `headroom=${typeof headroom === "number" ? `${headroom.toLocaleString()} tok (${formatTokenCount(headroom)})` : "n/a"}`,
    `usage=${typeof percent === "number" ? `${percent}%` : "n/a"}`,
  ].join("\n")}\n~~~`;
}

function formatRawTraceSummaryLine(
  params: Parameters<typeof buildInlineRawTracePayload>[0],
): string | undefined {
  const thinking = normalizeOptionalString(params.requestShaping?.thinking);
  const used = asPositiveFiniteNumber(params.promptTokens);
  const limit = asPositiveFiniteNumber(params.contextLimit);
  const fields = [
    params.executionTrace?.winnerModel
      ? `winner=${params.executionTrace.winnerModel}${thinking ? ` 🧠 ${thinking}` : ""}`
      : undefined,
    typeof params.executionTrace?.fallbackUsed === "boolean"
      ? `fallback=${params.executionTrace.fallbackUsed ? "yes" : "no"}`
      : undefined,
    typeof params.executionTrace?.attempts?.length === "number"
      ? `attempts=${params.executionTrace.attempts.length.toLocaleString()}`
      : undefined,
    params.completion?.stopReason ? `stop=${params.completion.stopReason}` : undefined,
    used !== undefined && limit !== undefined
      ? `prompt=${formatTokenCount(used)}/${formatTokenCount(limit)}`
      : undefined,
    ...TRACE_USAGE_FIELDS.map(([key, icon]) => {
      const value = params.usage?.[key];
      return typeof value === "number" && value > 0
        ? `${icon} ${formatTokenCount(value)}`
        : undefined;
    }),
    typeof params.toolSummary?.calls === "number" && params.toolSummary.calls > 0
      ? `tools=${params.toolSummary.calls.toLocaleString()}`
      : undefined,
    typeof params.contextManagement?.lastTurnCompactions === "number" &&
    params.contextManagement.lastTurnCompactions > 0
      ? `compactions=${params.contextManagement.lastTurnCompactions.toLocaleString()}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return fields.length > 0 ? `Summary: ${fields.join(" ")}` : undefined;
}

export function buildInlineRawTracePayload(
  params: Pick<
    EmbeddedAgentRunMeta,
    | "executionTrace"
    | "requestShaping"
    | "promptSegments"
    | "toolSummary"
    | "completion"
    | "contextManagement"
  > & {
    rawUserText?: string;
    rawAssistantText?: string;
    sessionUsage?: TraceUsageView;
    usage?: TraceUsageView;
    lastCallUsage?: TraceUsageView;
    provider?: string;
    model?: string;
    contextLimit?: number;
    promptTokens?: number;
  },
): ReplyPayload {
  const resolvedPromptTokens = deriveContextPromptTokens({
    lastCallUsage: params.lastCallUsage,
    promptTokens: params.promptTokens,
    usage: params.usage,
  });
  const requestContextBlock = formatRequestContextTraceBlock({
    provider: params.provider,
    model: params.model,
    contextLimit: params.contextLimit,
    promptTokens: resolvedPromptTokens,
  });
  const usageBlocks = [
    formatUsageTraceBlock("Usage (Session Total)", params.sessionUsage),
    formatUsageTraceBlock("Usage (Last Turn Total)", params.usage),
    requestContextBlock,
    formatExecutionResultTraceBlock(params.executionTrace),
    formatFallbackChainTraceBlock(params.executionTrace),
    formatKeyValueTraceBlock("Request Shaping", [
      ["provider", params.provider],
      ["model", params.model],
      ["auth", params.requestShaping?.authMode],
      ["thinking", params.requestShaping?.thinking],
      ["reasoning", params.requestShaping?.reasoning],
      ["verbose", params.requestShaping?.verbose],
      ["trace", params.requestShaping?.trace],
      ["fallbackEligible", params.requestShaping?.fallbackEligible],
      ["blockStreaming", params.requestShaping?.blockStreaming],
    ]),
    formatPromptSegmentsTraceBlock(params.promptSegments, params.rawUserText),
    formatToolSummaryTraceBlock(params.toolSummary),
    formatKeyValueTraceBlock("Completion", [
      ["finishReason", params.completion?.finishReason],
      ["stopReason", params.completion?.stopReason],
      ["refusal", params.completion?.refusal],
    ]),
    formatKeyValueTraceBlock("Context Management", [
      ["sessionCompactions", params.contextManagement?.sessionCompactions],
      ["lastTurnCompactions", params.contextManagement?.lastTurnCompactions],
      ["preflightCompactionApplied", params.contextManagement?.preflightCompactionApplied],
      ["postCompactionContextInjected", params.contextManagement?.postCompactionContextInjected],
    ]),
  ].filter((value): value is string => Boolean(value));
  return {
    text: [
      ...usageBlocks,
      formatRawTraceBlock("Model Input (User Role)", params.rawUserText),
      formatRawTraceBlock("Model Output (Assistant Role)", params.rawAssistantText),
      formatRawTraceSummaryLine({
        ...params,
        promptTokens: resolvedPromptTokens,
      }),
    ].join("\n\n\n"),
  };
}
