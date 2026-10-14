import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "../../../config/sessions/session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "../../../config/sessions/session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "../../../config/sessions/session-accessor.sqlite-contract.js";
import type { CurrentTranscriptProjection } from "../../../config/sessions/session-accessor.sqlite-projection-read.js";
import { loadTranscriptReadSnapshotSync } from "../../../config/sessions/session-accessor.sqlite-read.js";
import type { ResolvedTranscriptReadScope } from "../../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { selectVisibleTranscriptEvents } from "../../../config/sessions/transcript-visible-events.js";
import type { SessionMemoryTranscript } from "./capture.types.js";
import { countSessionMemoryMessages, getRecentSessionProjectionFromEvents } from "./transcript.js";

const SESSION_MEMORY_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_MEMORY_CAPTURE_PAGE_MESSAGES = 256;
const SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES = 4_096;

// The bounded reader already projects the active branch, but message pages
// omit intervening control ancestors. Relink this snapshot so the shared
// visibility selector can validate it without dropping active messages.
function relinkCapturedActiveMessageEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  let parentId: string | null = null;
  return events.map((event, index) => {
    if (!isRecord(event) || event.type !== "message") {
      return event;
    }
    const id = typeof event.id === "string" ? event.id : `session-memory-${index + 1}`;
    const linked = { ...event, id, parentId };
    parentId = id;
    return linked;
  });
}

function captureRecentSessionMemoryEvents(
  projection: CurrentTranscriptProjection,
  messageCount: number,
): TranscriptEvent[] {
  const captured: TranscriptEvent[] = [];
  let capturedBytes = 0;
  let offset = 0;
  let totalMessages = Number.POSITIVE_INFINITY;
  while (
    offset < totalMessages &&
    offset < SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES &&
    capturedBytes < SESSION_MEMORY_CAPTURE_MAX_BYTES &&
    countSessionMemoryMessages(
      selectVisibleTranscriptEvents(relinkCapturedActiveMessageEvents(captured)),
    ) < messageCount
  ) {
    const page = readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
      maxBytes: SESSION_MEMORY_CAPTURE_MAX_BYTES - capturedBytes,
      maxMessages: Math.min(
        SESSION_MEMORY_CAPTURE_PAGE_MESSAGES,
        SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES - offset,
      ),
      offset,
    });
    totalMessages = page.totalMessages;
    if (page.scannedMessages === 0) {
      break;
    }
    captured.unshift(...page.events.map(({ event }) => event));
    capturedBytes += page.serializedBytes;
    offset += page.scannedMessages;
  }
  return relinkCapturedActiveMessageEvents(captured);
}

// Memory excerpts span compactions, but never reach across the latest reset.
// Reset history replays only user/assistant rows; discard kept-prefix tools
// before applying capture budgets, just like the projection reader.
function selectCurrentMemoryWindow(events: TranscriptEvent[]): TranscriptEvent[] {
  const active = selectVisibleTranscriptEvents(events);
  const boundaryIndex = active.findLastIndex((event) => isRecord(event) && event.type === "reset");
  const boundary = active[boundaryIndex];
  if (!isRecord(boundary)) {
    return active;
  }
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? active.findIndex((event) => isRecord(event) && event.id === boundary.firstKeptEntryId)
      : -1;
  const kept =
    firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex
      ? active.slice(firstKeptIndex, boundaryIndex)
      : [];
  return [
    ...kept.filter(
      (event) =>
        isRecord(event) &&
        event.type === "message" &&
        isRecord(event.message) &&
        (event.message.role === "user" || event.message.role === "assistant"),
    ),
    ...active.slice(boundaryIndex + 1),
  ];
}

function captureAuthoritativeMemoryEvents(
  scope: SessionTranscriptReadScope,
  resolvedScope?: ResolvedTranscriptReadScope,
): TranscriptEvent[] {
  const messages = selectCurrentMemoryWindow(
    loadTranscriptReadSnapshotSync(scope, { readOnly: true, resolvedScope }).events,
  )
    .filter((event) => isRecord(event) && event.type === "message")
    .slice(-SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES);
  const captured: TranscriptEvent[] = [];
  let bytes = 0;
  for (const event of messages.toReversed()) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes + size <= SESSION_MEMORY_CAPTURE_MAX_BYTES) {
      captured.unshift(event);
      bytes += size;
    }
  }
  return relinkCapturedActiveMessageEvents(captured);
}

/** The retained history reader owns SQL; only the bounded excerpt leaves its snapshot. */
export function readSessionMemoryCapture({
  scope,
  resolvedScope,
  messageCount,
}: {
  scope: SessionTranscriptReadScope;
  resolvedScope?: ResolvedTranscriptReadScope;
  messageCount: number;
}): SessionMemoryTranscript {
  let events: TranscriptEvent[];
  try {
    events = withCurrentProjectionSnapshot(
      scope,
      (projection) => captureRecentSessionMemoryEvents(projection, messageCount),
      { readOnly: true, resolvedScope },
    );
  } catch {
    // Preserve capture during projection repair using authoritative rows.
    // This exceptional full read is capped before any snapshot escapes.
    events = captureAuthoritativeMemoryEvents(scope, resolvedScope);
  }
  const projection = getRecentSessionProjectionFromEvents(events, messageCount);
  return projection
    ? { status: "available", ...projection }
    : { status: "available", content: null, originClass: "agent" };
}
