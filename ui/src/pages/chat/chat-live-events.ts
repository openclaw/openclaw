import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";

type LiveEvents = typeof import("./chat-live-events.runtime.ts");
type PendingEvent = {
  event: GatewayEventFrame;
  isPresented: () => boolean;
  isCurrent: () => boolean;
};
type PendingEvents = { events: PendingEvent[]; disposed: boolean };
const pendingByPane = new WeakMap<ChatPageHost, PendingEvents>();
let runtime: LiveEvents | undefined;
let loading: Promise<LiveEvents> | undefined;

async function importChatLiveEvents(): Promise<LiveEvents> {
  const { handleChatLiveEvent } = await import("./chat-live-events.runtime.ts");
  return { handleChatLiveEvent };
}

function loadChatLiveEvents(): Promise<LiveEvents> {
  return (loading ??= importChatLiveEvents().then(
    (loaded) => (runtime = loaded),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));
}

export function isChatLiveEvent(event: GatewayEventFrame): boolean {
  return (
    event.event === "chat" ||
    event.event === "agent" ||
    event.event === "session.tool" ||
    event.event === "session.operation" ||
    event.event === "session.observer"
  );
}

export function dispatchChatLiveEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: () => boolean,
): void {
  const existing = pendingByPane.get(state);
  if (runtime && !existing) {
    runtime.handleChatLiveEvent(state, event, isPresented);
    return;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const sessionKey = state.sessionKey;
  const agentId = resolveChatAgentId(state);
  const sessionId = state.currentSessionId;
  const pending = existing ?? { events: [], disposed: false };
  pending.events.push({
    event,
    isPresented,
    isCurrent: () =>
      !pending.disposed &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      resolveChatAgentId(state) === agentId &&
      (!sessionId || state.currentSessionId === sessionId),
  });
  if (existing) {
    return;
  }
  pendingByPane.set(state, pending);
  void loadChatLiveEvents().then(
    (loaded) => {
      // Reentrant events join this same FIFO until every held frame is applied.
      try {
        let frame: PendingEvent | undefined;
        while ((frame = pending.events.shift())) {
          if (frame.isCurrent()) {
            loaded.handleChatLiveEvent(state, frame.event, frame.isPresented);
          }
        }
      } finally {
        pending.events.length = 0;
        if (pendingByPane.get(state) === pending) {
          pendingByPane.delete(state);
        }
      }
    },
    () => {
      if (pendingByPane.get(state) === pending) {
        pendingByPane.delete(state);
      }
      if (pending.events.some((frame) => frame.isCurrent())) {
        state.chatError = t("lazyView.staleSubtitle");
      }
      pending.events.length = 0;
    },
  );
}

export function retirePendingChatLiveEvents(state: ChatPageHost, runId?: string): void {
  const pending = pendingByPane.get(state);
  if (!pending) {
    return;
  }
  // A synchronous reset/row settlement wins over activity waiting for its code.
  // Keep terminal frames: their final display and delivery cleanup still belong here.
  pending.events = runId
    ? pending.events.filter(({ event }) => {
        const payload = asNullableRecord(event.payload);
        return (
          payload?.runId !== runId ||
          (event.event === "chat" &&
            (payload.state === "final" || payload.state === "error" || payload.state === "aborted"))
        );
      })
    : [];
}

export function disposeChatLiveEvents(state: ChatPageHost): void {
  const pending = pendingByPane.get(state);
  if (pending) {
    pending.disposed = true;
    pending.events.length = 0;
    pendingByPane.delete(state);
  }
}
