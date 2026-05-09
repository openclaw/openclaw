import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../config/sessions/transcript-store.sqlite.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";

/** Placeholder for blank user messages — preserves the user turn so strict
 * providers that require at least one user message don't reject the transcript. */
export const BLANK_USER_FALLBACK_TEXT = "(continue)";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  rewrittenAssistantMessages?: number;
  droppedBlankUserMessages?: number;
  rewrittenUserMessages?: number;
  reason?: string;
};

// The sentinel text is shared with stream-message-shared.ts and
// replay-history.ts so a repaired entry is byte-identical to a live
// stream-error turn, keeping the repair pass idempotent.

type SessionMessageEntry = {
  type: "message";
  message: { role: string; content?: unknown } & Record<string, unknown>;
} & Record<string, unknown>;

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
 * JSONL corruption (e.g. #77228 reported transcripts that contained 935+
 * entries with null roles after an earlier failure). They cannot be replayed
 * to any provider — every provider router branches on `message.role` — and
 * preserving them through repair just relocates the corruption from the
 * original file into the post-repair file. Treat them as malformed lines:
 * drop during repair so the cleaned transcript no longer carries them.
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
  droppedLines: number;
  rewrittenAssistantMessages: number;
  droppedBlankUserMessages: number;
  rewrittenUserMessages: number;
}): string {
  const parts: string[] = [];
  if (params.droppedLines > 0) {
    parts.push(`dropped ${params.droppedLines} malformed line(s)`);
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
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

export async function repairTranscriptStateIfNeeded(params: {
  transcriptLocator: string;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const transcriptLocator = params.transcriptLocator.trim();
  if (!transcriptLocator) {
    return { repaired: false, droppedLines: 0, reason: "missing session transcript" };
  }

  const scope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: transcriptLocator });
  if (!scope) {
    return { repaired: false, droppedLines: 0, reason: "missing SQLite transcript" };
  }

  const storedEntries = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  const entries: unknown[] = [];
  let droppedLines = 0;
  let rewrittenAssistantMessages = 0;
  let droppedBlankUserMessages = 0;
  let rewrittenUserMessages = 0;

  for (const entry of storedEntries) {
    if (isStructurallyInvalidMessageEntry(entry)) {
      // Drop "null role" / missing-role message entries the same way the old
      // JSONL repair dropped malformed lines: providers cannot replay them.
      droppedLines += 1;
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
    return { repaired: false, droppedLines, reason: "empty session transcript" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session transcript repair skipped: invalid session header (${transcriptLocator})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  if (
    droppedLines === 0 &&
    rewrittenAssistantMessages === 0 &&
    droppedBlankUserMessages === 0 &&
    rewrittenUserMessages === 0
  ) {
    return { repaired: false, droppedLines: 0 };
  }

  try {
    replaceSqliteSessionTranscriptEvents({
      ...scope,
      transcriptPath: transcriptLocator,
      events: entries,
    });
  } catch (err) {
    return {
      repaired: false,
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.debug?.(
    `session transcript repaired: ${buildRepairSummaryParts({
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
    })} (${transcriptLocator})`,
  );
  return {
    repaired: true,
    droppedLines,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
  };
}
