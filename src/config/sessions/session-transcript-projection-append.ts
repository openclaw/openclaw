import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptActiveFacts } from "./session-transcript-active-facts.js";
import type { PreparedTranscriptPayload, TranscriptPayloadRecord } from "./transcript-payload.js";
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

export type TranscriptIndexAppend = {
  preparedPayload?: PreparedTranscriptPayload;
  serializedBytes?: number;
  seq: number;
  event: unknown;
  eventId: string | null;
  createdAt: number;
};

export type SessionTranscriptProjectionCursor = {
  activeEventCount: number;
  activeMessageCount: number;
  indexedSeq: number;
  leafEventId: string | null;
};

export type SessionTranscriptProjectionState = SessionTranscriptProjectionCursor & {
  needsRebuild: boolean;
};

export type PreparedSessionTranscriptProjectionAppend = {
  activeRow?: {
    activePosition: number;
    contextEligible: 0 | 1;
    eventSeq: number;
    messagePosition: number | null;
    facts?: SessionTranscriptActiveFacts;
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
    if (
      !isRecord(block) ||
      (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text")
    ) {
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
  const message = isRecord(event) && (event.type === "custom_message" ? event : event.message);
  return isRecord(message) && message.excludeFromContext === true ? 0 : 1;
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

/** Inputs come from the payload writer; no payload-table lookup is needed. */
function prepareSessionTranscriptActiveFacts(
  payload: TranscriptPayloadRecord,
  contextEligible: number | null,
  serializedBytes: number,
): SessionTranscriptActiveFacts | undefined {
  // Invalid or native-depth-exceeding input keeps its existing read-time behavior.
  if (payload.navigation_valid === 0) {
    return undefined;
  }
  const candidate =
    payload.navigation_type === null ||
    payload.navigation_type === "custom" ||
    payload.navigation_type === "reset" ||
    (payload.navigation_type === "message" &&
      contextEligible === 0 &&
      payload.message_role === "assistant");
  return candidate
    ? { serializedBytes, payload }
    : { serializedBytes, dependencyNavigationJson: "{}" };
}

/** Resolves one append against an already-complete projection without mutating storage. */
export function prepareSessionTranscriptProjectionAppend(
  params: TranscriptIndexAppend & { cursor: SessionTranscriptProjectionCursor },
): PreparedSessionTranscriptProjectionAppend | undefined {
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
  const activeRow: PreparedSessionTranscriptProjectionAppend["activeRow"] = projectsActiveEvent
    ? {
        activePosition: cursor.activeEventCount,
        contextEligible: transcriptEventContextEligibility(params.event),
        eventSeq: params.seq,
        messagePosition: projectsMessage ? cursor.activeMessageCount : null,
      }
    : undefined;
  if (activeRow && params.preparedPayload && params.serializedBytes !== undefined) {
    activeRow.facts = prepareSessionTranscriptActiveFacts(
      params.preparedPayload.payload,
      activeRow.contextEligible,
      params.serializedBytes,
    );
  }
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
