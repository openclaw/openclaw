import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/** Placeholder for blank user messages — preserves the user turn so strict
 * providers that require at least one user message don't reject the transcript. */
export const BLANK_USER_FALLBACK_TEXT = "(continue)";

type RepairReport = {
  repaired: boolean;
  droppedEntries: number;
  rewrittenAssistantMessages?: number;
  droppedBlankUserMessages?: number;
  rewrittenUserMessages?: number;
  insertedToolResults?: number;
  reason?: string;
};

// The sentinel text is shared with stream-message-shared.ts and
// replay-history.ts so a repaired entry is byte-identical to a live
// stream-error turn, keeping the repair pass idempotent.

type SessionMessageEntry = {
  type: "message";
  message: { role: string; content?: unknown } & Record<string, unknown>;
} & Record<string, unknown>;

type TranscriptRepairScope = {
  agentId: string;
  sessionId: string;
};

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

/**
 * Detect a `type: "message"` entry whose `message.role` is missing, `null`, or
 * not a non-empty string. Such entries surface in the wild as "null role"
 * transcript corruption (e.g. #77228 reported transcripts that contained 935+
 * entries with null roles after an earlier failure). They cannot be replayed to
 * any provider — every provider router branches on `message.role` — and
 * preserving them through repair just relocates the corruption inside SQLite.
 * Drop them during repair so the cleaned transcript no longer carries them.
 */
function isStructurallyInvalidMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message") {
    return false;
  }
  if (!record.message || typeof record.message !== "object") {
    return true;
  }
  const role = (record.message as { role?: unknown }).role;
  return typeof role !== "string" || role.trim().length === 0;
}

function isAssistantEntryWithEmptyContent(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  if (message.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.content) || message.content.length !== 0) {
    return false;
  }
  // Only error stops — clean stops with empty content (NO_REPLY path) are
  // valid silent replies that must not be overwritten with synthetic text.
  return message.stopReason === "error";
}

function rewriteAssistantEntryWithEmptyContent(entry: SessionMessageEntry): SessionMessageEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
    },
  };
}

type UserEntryRepair =
  | { kind: "drop" }
  | { kind: "rewrite"; entry: SessionMessageEntry }
  | { kind: "keep" };

function repairUserEntryWithBlankTextContent(entry: SessionMessageEntry): UserEntryRepair {
  const content = entry.message.content;
  if (typeof content === "string") {
    if (content.trim()) {
      return { kind: "keep" };
    }
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: BLANK_USER_FALLBACK_TEXT,
        },
      },
    };
  }
  if (!Array.isArray(content)) {
    return { kind: "keep" };
  }

  let touched = false;
  const nextContent = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "text") {
      return true;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length > 0) {
      return true;
    }
    touched = true;
    return false;
  });
  if (nextContent.length === 0) {
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: [{ type: "text", text: BLANK_USER_FALLBACK_TEXT }],
        },
      },
    };
  }
  if (!touched) {
    return { kind: "keep" };
  }
  return {
    kind: "rewrite",
    entry: {
      ...entry,
      message: {
        ...entry.message,
        content: nextContent,
      },
    },
  };
}

function buildRepairSummaryParts(params: {
  droppedEntries: number;
  rewrittenAssistantMessages: number;
  droppedBlankUserMessages: number;
  rewrittenUserMessages: number;
  insertedToolResults: number;
}): string {
  const parts: string[] = [];
  if (params.droppedEntries > 0) {
    const noun = params.droppedEntries === 1 ? "entry" : "entries";
    parts.push(`dropped ${params.droppedEntries} malformed ${noun}`);
  }
  if (params.rewrittenAssistantMessages > 0) {
    parts.push(`rewrote ${params.rewrittenAssistantMessages} assistant message(s)`);
  }
  if (params.droppedBlankUserMessages > 0) {
    parts.push(`dropped ${params.droppedBlankUserMessages} blank user message(s)`);
  }
  if (params.rewrittenUserMessages > 0) {
    parts.push(`rewrote ${params.rewrittenUserMessages} user message(s)`);
  }
  if (params.insertedToolResults > 0) {
    parts.push(`inserted ${params.insertedToolResults} missing tool result(s)`);
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

function isCodeModeToolCallRepairCandidate(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    api?: unknown;
    provider?: unknown;
    stopReason?: unknown;
  };
  return (
    message.role === "assistant" &&
    message.api === "openai-codex-responses" &&
    message.provider === "openai-codex" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

function collectPersistedToolResultIds(entries: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type !== "message" || !record.message || typeof record.message !== "object") {
      continue;
    }
    const message = record.message as AgentMessage;
    if (message.role !== "toolResult") {
      continue;
    }
    const id = extractToolResultId(message);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function makeSyntheticToolResultEntry(params: {
  parent: SessionMessageEntry;
  toolCallId: string;
  toolName?: string;
}): SessionMessageEntry {
  const message = makeMissingToolResult({
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    text: "aborted",
  });
  return {
    type: "message",
    id: `repair-${randomUUID()}`,
    parentId: typeof params.parent.id === "string" ? params.parent.id : undefined,
    timestamp: new Date().toISOString(),
    message: message as unknown as SessionMessageEntry["message"],
  };
}

function insertMissingCodeModeToolResults(entries: unknown[]): {
  entries: unknown[];
  insertedToolResults: number;
} {
  const resultIds = collectPersistedToolResultIds(entries);
  let insertedToolResults = 0;
  const out: unknown[] = [];

  for (const entry of entries) {
    out.push(entry);
    if (!isCodeModeToolCallRepairCandidate(entry)) {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(
      entry.message as unknown as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) {
      if (resultIds.has(toolCall.id)) {
        continue;
      }
      out.push(
        makeSyntheticToolResultEntry({
          parent: entry,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }),
      );
      resultIds.add(toolCall.id);
      insertedToolResults += 1;
    }
  }

  return { entries: insertedToolResults > 0 ? out : entries, insertedToolResults };
}

async function repairTranscriptEntries(params: {
  scope: TranscriptRepairScope;
  label: string;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const storedEntries = loadSqliteSessionTranscriptEvents(params.scope).map((entry) => entry.event);
  const entries: unknown[] = [];
  let droppedEntries = 0;
  let rewrittenAssistantMessages = 0;
  let droppedBlankUserMessages = 0;
  let rewrittenUserMessages = 0;
  let insertedToolResults = 0;

  for (const entry of storedEntries) {
    if (isStructurallyInvalidMessageEntry(entry)) {
      // Drop "null role" / missing-role message entries: providers cannot replay them.
      droppedEntries += 1;
      continue;
    }
    if (isAssistantEntryWithEmptyContent(entry)) {
      entries.push(rewriteAssistantEntryWithEmptyContent(entry));
      rewrittenAssistantMessages += 1;
      continue;
    }
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "message" &&
      typeof (entry as { message?: unknown }).message === "object" &&
      ((entry as { message: { role?: unknown } }).message?.role ?? undefined) === "user"
    ) {
      const repairedUser = repairUserEntryWithBlankTextContent(entry as SessionMessageEntry);
      if (repairedUser.kind === "drop") {
        droppedBlankUserMessages += 1;
        continue;
      }
      if (repairedUser.kind === "rewrite") {
        entries.push(repairedUser.entry);
        rewrittenUserMessages += 1;
        continue;
      }
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    return { repaired: false, droppedEntries, reason: "empty session transcript" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(`session transcript repair skipped: invalid session header (${params.label})`);
    return { repaired: false, droppedEntries, reason: "invalid session header" };
  }

  if (
    droppedEntries === 0 &&
    rewrittenAssistantMessages === 0 &&
    droppedBlankUserMessages === 0 &&
    rewrittenUserMessages === 0
  ) {
    const repairedToolResults = insertMissingCodeModeToolResults(entries);
    insertedToolResults = repairedToolResults.insertedToolResults;
    if (insertedToolResults === 0) {
      return { repaired: false, droppedEntries: 0 };
    }
    entries.splice(0, entries.length, ...repairedToolResults.entries);
  } else {
    const repairedToolResults = insertMissingCodeModeToolResults(entries);
    insertedToolResults = repairedToolResults.insertedToolResults;
    if (insertedToolResults > 0) {
      entries.splice(0, entries.length, ...repairedToolResults.entries);
    }
  }

  try {
    replaceSqliteSessionTranscriptEvents({
      ...params.scope,
      events: entries,
    });
  } catch (err) {
    return {
      repaired: false,
      droppedEntries,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      insertedToolResults,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.debug?.(
    `session transcript repaired: ${buildRepairSummaryParts({
      droppedEntries,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      insertedToolResults,
    })} (${params.label})`,
  );
  return {
    repaired: true,
    droppedEntries,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    insertedToolResults,
  };
}

export async function repairTranscriptSessionStateIfNeeded(params: {
  agentId: string;
  sessionId: string;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const agentId = params.agentId.trim();
  const sessionId = params.sessionId.trim();
  if (!agentId || !sessionId) {
    return { repaired: false, droppedEntries: 0, reason: "missing SQLite transcript scope" };
  }

  return repairTranscriptEntries({
    scope: { agentId, sessionId },
    label: `agentId=${agentId} sessionId=${sessionId}`,
    debug: params.debug,
    warn: params.warn,
  });
}
