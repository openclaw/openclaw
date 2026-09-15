import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  isSessionTranscriptSideAppendEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";

export type TranscriptIndexEntry = {
  messageId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

export type SessionTranscriptProjectionCursor = {
  activeEventCount: number;
  activeMessageCount: number;
  indexedSeq: number;
  leafEventId: string | null;
};

export type PreparedSessionTranscriptProjectionAppend = {
  activeRow?: {
    activePosition: number;
    contextEligible: 0 | 1;
    eventSeq: number;
    messagePosition: number | null;
  };
  cursor: SessionTranscriptProjectionCursor;
  ftsRow?: TranscriptIndexEntry;
};

function readMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content.trim() || undefined;
  }
  if (typeof message.text === "string") {
    return message.text.trim() || undefined;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const parts = message.content.flatMap((block) => {
    if (!isRecord(block) || !["text", "input_text", "output_text"].includes(String(block.type))) {
      return [];
    }
    return typeof block.text === "string" && block.text.trim() ? [block.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Extracts the searchable user/assistant text from one transcript event. */
export function extractTranscriptIndexEntry(
  event: unknown,
  fallbackTimestamp: number,
): TranscriptIndexEntry | undefined {
  if (!isRecord(event) || event.type !== "message" || typeof event.id !== "string") {
    return undefined;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  const role = message?.role;
  const id = event.id.trim();
  if (!id || (role !== "user" && role !== "assistant")) {
    return undefined;
  }
  const text = readMessageText(message);
  if (!text) {
    return undefined;
  }
  const timestamp =
    typeof event.timestamp === "number"
      ? event.timestamp
      : typeof event.timestamp === "string"
        ? Date.parse(event.timestamp)
        : Number.NaN;
  return {
    messageId: id,
    role,
    text,
    timestamp: Number.isFinite(timestamp) ? timestamp : fallbackTimestamp,
  };
}

export function hasTranscriptMessage(event: unknown): boolean {
  return isRecord(event) && Object.hasOwn(event, "message") && event.message !== undefined;
}

/** Control facts still belong in bounded context acquisition, even without a replay message. */
export function transcriptEventContextEligibility(event: unknown): 0 | 1 {
  return isRecord(event) && isRecord(event.message) && event.message.excludeFromContext === true
    ? 0
    : 1;
}

export function shouldProjectActiveEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type !== "session" &&
    (isCanonicalSessionTranscriptEntry(event) ||
      parseSessionTranscriptTreeEntry(event) !== undefined ||
      hasTranscriptMessage(event))
  );
}

/** Resolves one append against an already-complete projection without mutating storage. */
export function prepareSessionTranscriptProjectionAppend(params: {
  createdAt: number;
  cursor: SessionTranscriptProjectionCursor;
  event: unknown;
  eventId: string | null;
  seq: number;
}): PreparedSessionTranscriptProjectionAppend | undefined {
  const { cursor } = params;
  const treeEntry = parseSessionTranscriptTreeEntry(params.event);
  const isCanonicalEvent = isCanonicalSessionTranscriptEntry(params.event);
  const initializesProjection = cursor.indexedSeq === -1;
  if (
    params.seq !== cursor.indexedSeq + 1 ||
    (!initializesProjection &&
      (isSessionTranscriptLeafControl(params.event) ||
        isSessionTranscriptSideAppendEntry(params.event) ||
        (isCanonicalEvent && cursor.leafEventId === null && cursor.activeEventCount > 0) ||
        (!isCanonicalEvent &&
          cursor.leafEventId !== null &&
          shouldProjectActiveEvent(params.event)) ||
        (treeEntry && treeEntry.parentId !== cursor.leafEventId)))
  ) {
    return undefined;
  }
  const ftsRow = extractTranscriptIndexEntry(params.event, params.createdAt);
  const projectsActiveEvent = shouldProjectActiveEvent(params.event);
  const projectsMessage = projectsActiveEvent && hasTranscriptMessage(params.event);
  const activeRow = projectsActiveEvent
    ? {
        activePosition: cursor.activeEventCount,
        contextEligible: transcriptEventContextEligibility(params.event),
        eventSeq: params.seq,
        messagePosition: projectsMessage ? cursor.activeMessageCount : null,
      }
    : undefined;
  return {
    ...(activeRow ? { activeRow } : {}),
    cursor: {
      activeEventCount: cursor.activeEventCount + (projectsActiveEvent ? 1 : 0),
      activeMessageCount: cursor.activeMessageCount + (projectsMessage ? 1 : 0),
      indexedSeq: params.seq,
      leafEventId:
        params.eventId !== null && isCanonicalEvent ? params.eventId : cursor.leafEventId,
    },
    ...(ftsRow ? { ftsRow } : {}),
  };
}
