import fs from "node:fs";
import type { SessionEntry } from "../config/sessions.js";
import {
  buildChatSummaryRecord,
  buildSummaryContextMessages,
  filterSyntheticSummaryMessages,
  formatChatSummary,
  isSyntheticSummaryMessage,
  readChatSummary,
  upsertChatIndex,
  writeChatSummary,
} from "../agents/chat-context-store.js";
import {
  DEFAULT_SUMMARY_HISTORY_TAIL,
  normalizeChatHistoryMode,
  normalizeSummaryHistoryTail,
  type ChatHistoryMode,
} from "../agents/context-policy.js";

type TranscriptHeader = {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
};

export type ContextBudgetBreakdown = {
  sessionKey: string;
  agentId: string;
  historyMode: ChatHistoryMode;
  summaryTokens: number;
  recentTailTokens: number;
  memoryTokens: number;
  finalTotalTokens: number;
  recentTailCount: number;
  summaryPresent: boolean;
  estimated: true;
};

function estimateTokenCount(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      return typeof (block as { text?: unknown }).text === "string"
        ? String((block as { text?: unknown }).text)
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildContextBudgetBreakdown(params: {
  sessionKey: string;
  agentId: string;
  historyMode: ChatHistoryMode;
  summaryText?: string | null;
  recentTailMessages: unknown[];
  memoryText?: string | null;
}): ContextBudgetBreakdown {
  const summaryTokens = estimateTokenCount(params.summaryText ?? "");
  const recentTailTokens = params.recentTailMessages.reduce(
    (total: number, message) => total + estimateTokenCount(extractMessageText(message)),
    0,
  );
  const memoryTokens = estimateTokenCount(params.memoryText ?? "");
  return {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    historyMode: params.historyMode,
    summaryTokens,
    recentTailTokens,
    memoryTokens,
    finalTotalTokens: summaryTokens + recentTailTokens + memoryTokens,
    recentTailCount: params.recentTailMessages.length,
    summaryPresent: summaryTokens > 0,
    estimated: true,
  };
}

function parseHeader(line: string): TranscriptHeader | null {
  try {
    const parsed = JSON.parse(line) as TranscriptHeader;
    return parsed && parsed.type === "session" ? parsed : null;
  } catch {
    return null;
  }
}

function assertSingleSummaryInvariant(messages: unknown[]) {
  const summaryMessages = messages.filter((message) => isSyntheticSummaryMessage(message));
  if (summaryMessages.length > 1) {
    throw new Error("context assembly invariant violated: multiple summary messages");
  }
  if (summaryMessages.length === 1 && messages[0] !== summaryMessages[0]) {
    throw new Error("context assembly invariant violated: summary must precede recent tail");
  }
}

function assertSummaryRecordInvariant(
  summary: ReturnType<typeof readChatSummary> | ReturnType<typeof buildChatSummaryRecord>,
) {
  if (!summary) {
    return;
  }
  const required = [
    ["currentGoal", summary.currentGoal],
    ["currentStatus", summary.currentStatus],
    ["keyDecisions", summary.keyDecisions],
    ["nextActions", summary.nextActions],
  ] as const;
  for (const [label, values] of required) {
    if (!Array.isArray(values)) {
      throw new Error(`summary invariant violated: ${label} missing`);
    }
  }
  if (!summary.technicalFacts) {
    throw new Error("summary invariant violated: technicalFacts missing");
  }
}

export function resolveEffectiveHistoryMode(value: unknown, entry?: SessionEntry): ChatHistoryMode {
  return normalizeChatHistoryMode(value ?? entry?.historyLoadMode);
}

export function applyChatHistoryWindow(params: {
  agentId: string;
  sessionKey: string;
  messages: unknown[];
  entry?: SessionEntry;
  historyMode?: unknown;
  tailCount?: unknown;
}): {
  historyMode: ChatHistoryMode;
  tailCount: number;
  messages: unknown[];
  summary: string | null;
  budget: ContextBudgetBreakdown;
} {
  const historyMode = resolveEffectiveHistoryMode(params.historyMode, params.entry);
  const tailCount = normalizeSummaryHistoryTail(params.tailCount);
  const summary = readChatSummary({ agentId: params.agentId, sessionKey: params.sessionKey });
  assertSummaryRecordInvariant(summary);
  const normalizedMessages = filterSyntheticSummaryMessages(params.messages);
  const assembledMessages = buildSummaryContextMessages({
    messages: normalizedMessages,
    summary,
    tailCount,
    mode: historyMode,
  });
  assertSingleSummaryInvariant(assembledMessages);
  const recentTailMessages = assembledMessages.filter(
    (message) => !isSyntheticSummaryMessage(message),
  );
  return {
    historyMode,
    tailCount,
    summary: summary ? formatChatSummary(summary) : null,
    messages: assembledMessages,
    budget: buildContextBudgetBreakdown({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      historyMode,
      summaryText: summary ? formatChatSummary(summary) : null,
      recentTailMessages,
      memoryText: null,
    }),
  };
}

export function persistChatSummary(params: {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  entry?: SessionEntry;
  messages: unknown[];
}) {
  const previous = readChatSummary({ agentId: params.agentId, sessionKey: params.sessionKey });
  const sourceMessages = filterSyntheticSummaryMessages(params.messages).filter(
    (message) => !isSyntheticSummaryMessage(message),
  );
  const summary = buildChatSummaryRecord({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    messages: sourceMessages,
    previous,
  });
  assertSummaryRecordInvariant(summary);
  writeChatSummary(summary);
  upsertChatIndex({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    historyMode: params.entry?.historyLoadMode,
    archivedAt: params.entry?.archivedAt,
    summaryUpdatedAt: summary.updatedAt,
  });
  return summary;
}

export function rewriteTranscriptWithSummary(params: {
  transcriptPath: string;
  summaryText: string;
  keepMessages: unknown[];
  summaryGeneration?: number;
}) {
  const rawLines = fs
    .readFileSync(params.transcriptPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const header = rawLines[0] ? parseHeader(rawLines[0]) : null;
  const nextLines: string[] = [];
  if (header) {
    nextLines.push(JSON.stringify(header));
  }
  nextLines.push(
    JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: params.summaryText }],
      timestamp: Date.now(),
      synthetic: true,
      summary: true,
      summaryGeneration: params.summaryGeneration ?? 1,
    }),
  );
  for (const message of params.keepMessages) {
    nextLines.push(JSON.stringify(message));
  }
  fs.writeFileSync(params.transcriptPath, `${nextLines.join("\n")}\n`, "utf-8");
}

export function compactTranscriptForPreflight(params: {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  entry?: SessionEntry;
  transcriptPath: string;
  messages: unknown[];
}) {
  const sourceMessages = filterSyntheticSummaryMessages(params.messages).filter(
    (message) => !isSyntheticSummaryMessage(message),
  );
  if (sourceMessages.length === 0) {
    return {
      compacted: false,
      summary: null,
      keptMessages: [] as unknown[],
    };
  }
  const summary = persistChatSummary({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    entry: params.entry,
    messages: sourceMessages,
  });
  const reduced = applyChatHistoryWindow({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messages: sourceMessages,
    entry: params.entry ? { ...params.entry, historyLoadMode: "summary" } : undefined,
    historyMode: "summary",
    tailCount: DEFAULT_SUMMARY_HISTORY_TAIL,
  });
  rewriteTranscriptWithSummary({
    transcriptPath: params.transcriptPath,
    summaryText: reduced.summary ?? "[Context summary]",
    keepMessages: reduced.messages.slice(1),
    summaryGeneration: summary.summaryGeneration,
  });
  return {
    compacted: true,
    summary,
    keptMessages: reduced.messages,
  };
}
