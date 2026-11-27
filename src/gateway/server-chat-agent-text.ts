import type { AgentEventPayload } from "../infra/agent-events.js";
import { shouldSuppressAssistantEventForLiveChat } from "./live-chat-projector.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import {
  assistantWireProjection,
  cancelPendingLiveTextFlush,
  liveTextDelivery,
  mergeAgentTextPayload,
  scheduleLiveTextFlush,
} from "./server-chat-live-text.js";
import type { BufferedAgentEvent, ChatRunState } from "./server-chat-state.js";

type ChatRunRecord = ReturnType<ChatRunState["getOrCreate"]>;
type AgentTextThrottleStream = keyof NonNullable<ChatRunRecord["agentText"]>;
export type LivePayloadOptions = {
  agentId?: string;
  controlUiVisible?: boolean;
  dropIfSlow?: boolean;
  liveText?: GatewayBroadcastOpts["liveText"];
};

export function createAgentTextDelivery({
  chatRunState,
  pacingMs,
  send,
}: {
  chatRunState: ChatRunState;
  pacingMs: number;
  send: (
    sessionKey: string | undefined,
    payload: BufferedAgentEvent["payload"],
    opts?: LivePayloadOptions,
  ) => void;
}) {
  const sendAgentPayload = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
    opts?: LivePayloadOptions & { coalesce?: boolean; isCurrent?: () => boolean; settle?: true },
  ) => {
    const stream = resolveAgentTextThrottleStream(payload);
    const deliveryKey = JSON.stringify([
      "agent",
      stream,
      payload.data.itemId,
      sessionKey,
      opts?.agentId,
      opts?.controlUiVisible ?? true,
    ]);
    const liveText = liveTextDelivery(
      chatRunState,
      payload.runId,
      stream && opts?.coalesce
        ? {
            key: deliveryKey,
            merge: mergeAgentTextPayload,
          }
        : undefined,
      opts?.isCurrent,
      assistantWireProjection(payload, sessionKey, opts?.agentId, opts?.controlUiVisible ?? true),
    );
    if (liveText && opts?.settle) {
      liveText.settle = true;
    }
    send(sessionKey, payload, { ...opts, liveText });
  };

  const flushBufferedAgentDeltaIfNeeded = (clientRunId: string) => {
    const run = chatRunState.runs.get(clientRunId);
    cancelPendingLiveTextFlush(run, "agent");
    const states = Object.values(run?.agentText ?? {});
    states.sort(
      (a, b) => (a.bufferedEvent?.payload.seq ?? 0) - (b.bufferedEvent?.payload.seq ?? 0),
    );
    for (const state of states) {
      const buffered = state.bufferedEvent;
      if (!buffered) {
        continue;
      }
      delete state.bufferedEvent;
      if (buffered.isCurrent?.() === false) {
        continue;
      }
      state.lastSentAt = Date.now();
      sendAgentPayload(buffered.sessionKey, buffered.payload, {
        agentId: buffered.agentId,
        controlUiVisible: buffered.controlUiVisible,
        dropIfSlow: buffered.controlUiVisible === false,
        coalesce: true,
        isCurrent: buffered.isCurrent,
      });
    }
  };

  const resolveAgentTextThrottleStream = (
    evt: AgentEventPayload,
  ): AgentTextThrottleStream | null => {
    if (evt.stream === "assistant" || evt.stream === "thinking") {
      const stream = evt.stream === "assistant" ? "assistant" : "thinking";
      return typeof evt.data.delta === "string" || evt.data.replace === true ? stream : null;
    }
    const { kind, phase, status, itemId, progressText } = evt.data;
    // Growing previews share text pacing; completion and selection remain ordering barriers.
    return evt.stream === "item" &&
      phase === "update" &&
      (kind === "preamble" || (kind === "answer_candidate" && status === "candidate")) &&
      typeof itemId === "string" &&
      typeof progressText === "string"
      ? kind
      : null;
  };

  const shouldCoalesceAgentTextEvent = (evt: AgentEventPayload) =>
    !(Array.isArray(evt.data.mediaUrls) && evt.data.mediaUrls.length > 0) &&
    typeof evt.data.mediaUrl !== "string" &&
    evt.data.replace !== true &&
    (evt.stream === "item" ||
      (typeof evt.data.text === "string" &&
        typeof evt.data.delta === "string" &&
        evt.data.delta.length > 0 &&
        (evt.stream !== "assistant" || !shouldSuppressAssistantEventForLiveChat(evt.data))));

  const sendOrBufferAgentTextEvent = (
    clientRunId: string,
    next: BufferedAgentEvent,
    settle?: true,
  ) => {
    const { payload } = next;
    const stream = resolveAgentTextThrottleStream(payload);
    const now = Date.now();
    const run = stream ? chatRunState.getOrCreate(clientRunId) : undefined;
    const state = run && stream ? ((run.agentText ??= {})[stream] ??= {}) : undefined;
    const last = state?.lastSentAt;
    const previous = state?.bufferedEvent;
    // Even an overdue wake owns delivery; flushing on ingress defeats batching
    // while a busy event loop is still draining provider notifications.
    if (
      run &&
      state &&
      last !== undefined &&
      shouldCoalesceAgentTextEvent(payload) &&
      (!previous ||
        (previous.payload.data.itemId === payload.data.itemId &&
          previous.sessionKey === next.sessionKey &&
          previous.agentId === next.agentId &&
          previous.controlUiVisible === next.controlUiVisible &&
          previous.isCurrent?.() !== false))
    ) {
      // Deltas accumulate, while item progress replaces its cumulative snapshot.
      state.bufferedEvent = {
        ...next,
        payload: previous ? mergeAgentTextPayload(previous.payload, payload) : payload,
      };
      scheduleLiveTextFlush(run, "agent", pacingMs - (now - last), () =>
        flushBufferedAgentDeltaIfNeeded(clientRunId),
      );
      return;
    }
    flushBufferedAgentDeltaIfNeeded(clientRunId);
    sendAgentPayload(next.sessionKey, payload, {
      agentId: next.agentId,
      controlUiVisible: next.controlUiVisible,
      dropIfSlow: next.controlUiVisible === false,
      isCurrent: next.isCurrent,
      settle,
    });
    if (state) {
      state.lastSentAt = now;
    }
  };

  return { sendAgentPayload, flushBufferedAgentDeltaIfNeeded, sendOrBufferAgentTextEvent };
}
