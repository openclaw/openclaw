import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { RealtimeTalkEvent } from "./realtime-talk-shared.js";

/** Payload shape for a chat event frame from the gateway. */
export type ChatPayload = {
  runId?: string;
  stream?: string;
  state?: string;
  errorMessage?: string;
  data?: unknown;
  message?: unknown;
};

/** Input shape for emitting a realtime talk event to the client. */
export type RealtimeTalkEventInput<TPayload = unknown> = {
  type: RealtimeTalkEvent["type"];
  payload?: TPayload;
  turnId?: string;
  captureId?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};

/** Result of processing a chat event — either settled or needs further action. */
export type ChatEventDisposition =
  | { type: "terminal"; text?: string }
  | { type: "empty_final_fallback" }
  | { type: "aborted"; errorMessage?: string }
  | { type: "errored"; errorMessage?: string }
  | { type: "progress" }
  | { type: "buffer" }
  | { type: "ignore" };

export interface ChatHandlerDeps {
  runId: string;
  emitTalkEvent: ((input: RealtimeTalkEventInput) => void) | undefined;
  extractTextFromMessage: (message: unknown) => string;
}

/**
 * Encapsulates chat event processing for a realtime talk consult, including
 * buffering of events that may belong to a not-yet-discovered follow-up run.
 *
 * When a turn is queued (pending), the follow-up runId is allocated
 * asynchronously after `admitFollowupTurn` runs. Chat events for the
 * follow-up may arrive before the runId is discovered. This handler buffers
 * such events and replays them once `acceptedFollowupRunId` is set, recovering
 * any terminal result (final, aborted, error) that would otherwise be lost.
 *
 * Callers receive `ChatEventDisposition` results and own the settlement
 * lifecycle (resolve/reject/cleanup) — the handler owns only the runId
 * correlation, buffering, and replay logic.
 */
/** Maximum number of terminal events retained for recovery before follow-up ID discovery. */
const MAX_BUFFERED_TERMINAL_EVENTS = 4;
/** Approximate byte ceiling for buffered terminal events. */
const MAX_BUFFERED_BYTES = 64 * 1024;

function estimatePayloadBytes(payload: ChatPayload): number {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return 0;
  }
}

export function createChatHandler(deps: ChatHandlerDeps) {
  // Only buffer terminal events (final, aborted, error) — progress/deltas
  // from unrelated runs are not needed for recovery and can consume unbounded
  // memory through streaming snapshots.
  const bufferedFollowupEvents: ChatPayload[] = [];
  let acceptedFollowupRunId: string | undefined;
  let bufferedBytes = 0;

  const matchesActiveRun = (payloadRunId: string): boolean => {
    if (payloadRunId === deps.runId) {
      return true;
    }
    // After a pending queued turn, the follow-up run gets a new random runId
    // that the gateway communicates via followupRunId in the wait response.
    // Only accept events carrying that exact follow-up runId.
    if (acceptedFollowupRunId && payloadRunId === acceptedFollowupRunId) {
      return true;
    }
    return false;
  };

  const bufferEvent = (payload: ChatPayload) => {
    const bytes = estimatePayloadBytes(payload);
    if (
      bufferedFollowupEvents.length >= MAX_BUFFERED_TERMINAL_EVENTS ||
      bufferedBytes + bytes > MAX_BUFFERED_BYTES
    ) {
      // Drop the oldest entry to make room, preserving newest terminal events.
      const oldest = bufferedFollowupEvents.shift();
      if (oldest) {
        bufferedBytes -= estimatePayloadBytes(oldest);
      }
    }
    bufferedFollowupEvents.push(payload);
    bufferedBytes += bytes;
  };

  const processChatEvent = (payload: ChatPayload): ChatEventDisposition => {
    if (!matchesActiveRun(payload.runId ?? "")) {
      // A chat event arrived for a run we don't recognize. If we haven't
      // discovered the follow-up runId yet, buffer terminal events (final,
      // aborted, error) so they can be recovered for replay. Progress deltas
      // and full stream snapshots are not needed for recovery and are dropped
      // to bound memory usage. Once the follow-up runId is known, unmatched
      // events are genuinely unrelated and can be safely dropped.
      if (!acceptedFollowupRunId) {
        if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
          bufferEvent(payload);
        }
      }
      return { type: "buffer" };
    }
    // This event belongs to a known active run. Clear the buffer since we
    // no longer need to check future events against the undiscovered runId.
    bufferedFollowupEvents.length = 0;
    bufferedBytes = 0;

    if (payload.stream === "tool") {
      emitRealtimeTalkAgentProgress(deps.emitTalkEvent, payload);
    }

    if (payload.state === "final") {
      const finalText = deps.extractTextFromMessage(payload.message);
      if (finalText) {
        return { type: "terminal", text: finalText };
      }
      return { type: "empty_final_fallback" };
    }
    if (payload.state === "aborted") {
      return { type: "aborted", errorMessage: payload.errorMessage };
    }
    if (payload.state === "error") {
      return { type: "errored", errorMessage: payload.errorMessage };
    }
    return { type: "progress" };
  };

  /** Replay buffered events after the follow-up runId has been discovered.
   * This recovers terminal results (final, aborted, error) that arrived
   * before we knew the follow-up runId, so they were previously discarded.
   * Returns dispositions for the caller to act on. */
  const replayBufferedFollowupEvents = (): ChatEventDisposition[] => {
    if (bufferedFollowupEvents.length === 0) {
      return [];
    }
    // Take a snapshot and clear the buffer; processChatEvent will re-buffer
    // any that still don't match.
    const snapshot = bufferedFollowupEvents.splice(0);
    return snapshot.map((payload) => processChatEvent(payload));
  };

  const handleEvent = (evt: GatewayEventFrame): ChatEventDisposition | undefined => {
    if (evt.event !== "chat") {
      return undefined;
    }
    // SAFETY: chat event payload is the unstructured chat envelope from the gateway.
    const payload = evt.payload as ChatPayload | undefined;
    if (!payload) {
      return undefined;
    }
    return processChatEvent(payload);
  };

  const cleanup = () => {
    bufferedFollowupEvents.length = 0;
    bufferedBytes = 0;
  };

  return {
    handleEvent,
    cleanup,
    setAcceptedFollowupRunId: (followupRunId: string) => {
      acceptedFollowupRunId = followupRunId;
    },
    getAcceptedFollowupRunId: () => acceptedFollowupRunId,
    replayBufferedFollowupEvents,
  };
}

/** Emit a tool.progress talk event from a chat payload. */
function emitRealtimeTalkAgentProgress(
  emitTalkEvent: ((input: RealtimeTalkEventInput) => void) | undefined,
  payload: ChatPayload,
): void {
  if (!emitTalkEvent || payload.stream !== "tool") {
    return;
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  // SAFETY: data is an opaque object from the tool.progress payload.
  const record = data as Record<string, unknown>;
  const phase = typeof record.phase === "string" ? record.phase : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
  emitTalkEvent({
    type: "tool.progress",
    callId: toolCallId,
    payload: {
      runId: payload.runId,
      ...(name ? { name } : {}),
      ...(phase ? { phase } : {}),
    },
  });
}
