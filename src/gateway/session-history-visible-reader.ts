import {
  readSessionTranscriptVisibleMessagePage,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  isSqliteReadTarget,
  resolveTranscriptReadTarget,
  sqliteMessageEventWithRawSeq,
  toTranscriptReadScope,
} from "./session-transcript-readers.js";

const VISIBLE_HISTORY_CURSOR_VERSION = 1;
const MAX_VISIBLE_HISTORY_CURSOR_LENGTH = 4_096;

type VisibleHistoryCursor = {
  agentId: string;
  anchorEventSeq: number;
  direction: "older";
  generation: string;
  sessionId: string;
  sessionKey: string;
  version: typeof VISIBLE_HISTORY_CURSOR_VERSION;
};

export type VisibleSessionMessageAnchor = {
  eventSeq: number;
  rawSeq: number;
  visibleSeq: number;
};

export type VisibleHistoryCursorResetReason =
  | "anchor_missing"
  | "generation_mismatch"
  | "invalid_cursor"
  | "scope_mismatch";

export type ReadVisibleSessionMessagesResult =
  | {
      anchors: VisibleSessionMessageAnchor[];
      generation: string;
      hasMore: boolean;
      kind: "page";
      messages: unknown[];
      rawTranscriptSeq: number;
      totalMessages: number;
      transcriptPath: string;
    }
  | {
      generation: string;
      kind: "reset";
      reason: "anchor_missing" | "generation_mismatch";
    }
  | { kind: "missing" }
  | { kind: "unsupported" };

export type ReadVisibleSessionMessagesCursorResult =
  | Extract<ReadVisibleSessionMessagesResult, { kind: "page" | "missing" | "unsupported" }>
  | { kind: "reset"; reason: VisibleHistoryCursorResetReason };

function encodeVisibleHistoryCursor(cursor: VisibleHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseVisibleHistoryCursor(value: string): VisibleHistoryCursor | undefined {
  if (value.length > MAX_VISIBLE_HISTORY_CURSOR_LENGTH) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<VisibleHistoryCursor>;
    if (
      parsed.version !== VISIBLE_HISTORY_CURSOR_VERSION ||
      parsed.direction !== "older" ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.generation !== "string" ||
      parsed.generation.length === 0 ||
      !Number.isSafeInteger(parsed.anchorEventSeq) ||
      (parsed.anchorEventSeq ?? -1) < 0
    ) {
      return undefined;
    }
    return parsed as VisibleHistoryCursor;
  } catch {
    return undefined;
  }
}

function cursorMatchesScope(
  cursor: VisibleHistoryCursor,
  scope: SessionTranscriptReadScope,
): boolean {
  return (
    cursor.agentId === normalizeAgentId(scope.agentId) &&
    cursor.sessionId === scope.sessionId &&
    cursor.sessionKey === (scope.sessionKey ?? "")
  );
}

/** Returns whether a value is a well-formed opaque visible-history cursor. */
export function isVisibleHistoryCursor(value: string | undefined): boolean {
  return typeof value === "string" && parseVisibleHistoryCursor(value) !== undefined;
}

/** Encodes an older-page cursor at an active visible-message event boundary. */
export function encodeVisibleSessionMessagesCursor(params: {
  anchorEventSeq: number;
  generation: string;
  scope: SessionTranscriptReadScope;
}): string {
  return encodeVisibleHistoryCursor({
    agentId: normalizeAgentId(params.scope.agentId),
    anchorEventSeq: params.anchorEventSeq,
    direction: "older",
    generation: params.generation,
    sessionId: params.scope.sessionId,
    sessionKey: params.scope.sessionKey ?? "",
    version: VISIBLE_HISTORY_CURSOR_VERSION,
  });
}

/** Reads one SQLite visible-history raw window from the active projection. */
export async function readVisibleSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: {
    before?: { eventSeq: number; generation: string };
    maxMessages: number;
  },
): Promise<ReadVisibleSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (!isSqliteReadTarget(target)) {
    return { kind: "unsupported" };
  }
  const result = readSessionTranscriptVisibleMessagePage(toTranscriptReadScope(target), opts);
  if (result.kind === "missing") {
    return result;
  }
  if (result.kind === "reset") {
    return result;
  }
  const entries = result.events.flatMap((entry) => {
    const message = sqliteMessageEventWithRawSeq(entry);
    return message === undefined ? [] : [{ entry, message }];
  });
  return {
    anchors: entries.map(({ entry }) => ({
      eventSeq: entry.eventSeq,
      rawSeq: entry.eventSeq + 1,
      visibleSeq: entry.messagePosition + 1,
    })),
    generation: result.generation,
    hasMore: result.hasMore,
    kind: "page",
    messages: entries.map(({ message }) => message),
    rawTranscriptSeq: result.rawTranscriptSeq,
    totalMessages: result.totalMessages,
    transcriptPath: target.sessionFile,
  };
}

/** Reads one strict opaque visible-history page without applying caller reset policy. */
export async function readVisibleSessionMessagesCursorPageAsync(
  scope: SessionTranscriptReadScope,
  opts: { cursor?: string; maxMessages: number },
): Promise<ReadVisibleSessionMessagesCursorResult> {
  const decodedCursor = opts.cursor ? parseVisibleHistoryCursor(opts.cursor) : undefined;
  if (opts.cursor && !decodedCursor) {
    return { kind: "reset", reason: "invalid_cursor" };
  }
  if (decodedCursor && !cursorMatchesScope(decodedCursor, scope)) {
    return { kind: "reset", reason: "scope_mismatch" };
  }
  const page = await readVisibleSessionMessagesAsync(scope, {
    ...(decodedCursor
      ? {
          before: {
            eventSeq: decodedCursor.anchorEventSeq,
            generation: decodedCursor.generation,
          },
        }
      : {}),
    maxMessages: opts.maxMessages,
  });
  return page.kind === "reset" ? { kind: "reset", reason: page.reason } : page;
}
