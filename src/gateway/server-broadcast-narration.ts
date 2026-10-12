import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseAgentSessionKey } from "@openclaw/session-url-contract/session-key-normalization";
import type { SessionNarrationEvent } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../shared/text/assistant-visible-text.js";
import type {
  GatewayBroadcastOpts,
  GatewayBroadcastToConnIdsFn,
} from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const NARRATION_INTERVAL_MS = 2_000;
const NARRATION_TAIL_CHARS = 16_384;

type PendingNarration = {
  payload: Record<string, unknown>;
  projection: NarrationProjection;
  sessionKeys: readonly string[];
  opts?: GatewayBroadcastOpts;
};
type NarrationState = {
  subscriptionKeys: readonly string[];
  lastSentAt?: number;
  last?: SessionNarrationEvent;
  pending?: PendingNarration;
  timer?: ReturnType<typeof setTimeout>;
};
type ConnectionNarration = {
  socket: GatewayWsClient["socket"];
  sessions: Map<string, NarrationState>;
  close: () => void;
};
type NarrationProjection = {
  explicitAgentId?: string;
  agentId?: string;
  key: string;
  digest?: SessionNarrationEvent;
};

/** Per-session pacing retains only the newest publication, never token queues. */
export function createGatewayNarrationDelivery(params: {
  clients: GatewayClientRegistry;
  sessionMessageSubscribers?: SessionMessageSubscriberRegistry;
  send: GatewayBroadcastToConnIdsFn;
}) {
  const connections = new WeakMap<GatewayWsClient, ConnectionNarration>();
  const projections = new WeakMap<object, NarrationProjection>();
  const subscribers = params.sessionMessageSubscribers;

  const isNarration = (connId: string, keys: readonly string[]) => {
    let subscribed = false;
    for (const key of keys) {
      if (subscribers?.get(key).has(connId)) {
        if (!subscribers.getNarration(key).has(connId)) {
          return false;
        }
        subscribed = true;
      }
    }
    return subscribed;
  };
  const cancelPending = (state: NarrationState) => {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.pending = undefined;
  };
  const connectionFor = (client: GatewayWsClient) => {
    const existing = connections.get(client);
    if (existing?.socket === client.socket) {
      return existing;
    }
    existing?.close();
    const socket = client.socket;
    const sessions = new Map<string, NarrationState>();
    const close = () => {
      for (const state of sessions.values()) {
        cancelPending(state);
      }
      sessions.clear();
      socket.off("close", close);
      connections.delete(client);
    };
    const connection = { socket, sessions, close };
    connections.set(client, connection);
    socket.once("close", close);
    return connection;
  };
  subscribers?.onChange((key, connId) => {
    const client = params.clients.getByConnectionId(connId);
    const connection = client && connections.get(client);
    if (!connection) {
      return;
    }
    // A new intent cannot inherit queued text from the previous subscription.
    for (const [sessionKey, state] of connection.sessions) {
      if (state.subscriptionKeys.includes(key)) {
        cancelPending(state);
        connection.sessions.delete(sessionKey);
      }
    }
    if (connection.sessions.size === 0) {
      connection.close();
    }
  });
  const projectionFor = (
    payload: Record<string, unknown>,
    sessionKey: string,
    explicitAgentId?: string,
  ): NarrationProjection => {
    const existing = projections.get(payload);
    if (existing && existing.explicitAgentId === explicitAgentId) {
      return existing;
    }
    const agentId =
      normalizeOptionalLowercaseString(explicitAgentId ?? payload.agentId) ??
      parseAgentSessionKey(sessionKey)?.agentId;
    const projection = {
      explicitAgentId,
      agentId,
      key: `${sessionKey.length}:${sessionKey}${agentId ?? ""}`,
    };
    projections.set(payload, projection);
    return projection;
  };
  const project = (
    payload: Record<string, unknown>,
    projection: NarrationProjection,
  ): SessionNarrationEvent => {
    if (projection.digest) {
      return projection.digest;
    }
    // Filter the complete snapshot before slicing: a tail can start inside a
    // hidden block whose opening marker no longer fits in the bounded digest.
    const visible = stripInternalRuntimeContext(
      sanitizeAssistantVisibleTextWithProfile(
        extractAssistantPhaseText(payload.message) ?? "",
        "internal-scaffolding",
        payload.state === "delta",
      ),
      { streaming: payload.state === "delta" },
    );
    const digest: SessionNarrationEvent = {
      sessionKey: String(payload.sessionKey),
      runId: String(payload.runId),
      ...(projection.agentId ? { agentId: projection.agentId } : {}),
      text: sliceUtf16Safe(visible, -NARRATION_TAIL_CHARS),
    };
    projection.digest = digest;
    return digest;
  };
  const flush = (
    client: GatewayWsClient,
    connection: ConnectionNarration,
    state: NarrationState,
  ) => {
    const pending = state.pending;
    cancelPending(state);
    if (!pending || client.socket !== connection.socket || !params.clients.has(client)) {
      return;
    }
    const { payload, projection, sessionKeys, opts } = pending;
    const live = opts?.liveText;
    if (!isNarration(client.connId, sessionKeys) || live?.group.aborted) {
      return;
    }
    try {
      if (live?.isCurrent?.() === false) {
        return;
      }
    } catch {
      return;
    }
    const digest = project(payload, projection);
    if (state.last?.runId === digest.runId && state.last.text === digest.text) {
      return;
    }
    state.lastSentAt = Date.now();
    state.last = digest;
    // Re-enter the normal broadcaster so delayed delivery rechecks scopes,
    // sharing, subscription mode, socket liveness, and slow-consumer policy.
    params.send("session.narration", digest, new Set([client.connId]), {
      sessionKeys,
      agentId: projection.agentId,
      dropIfSlow: true,
      sessionSubscriptionVerified: true,
    });
  };

  return {
    isNarration,
    consume: (
      client: GatewayWsClient,
      event: string,
      payload: unknown,
      sessionKeys: readonly string[],
      opts?: GatewayBroadcastOpts,
    ): boolean => {
      if (!isRecord(payload) || !isNarration(client.connId, sessionKeys)) {
        return false;
      }
      // The chat projection owns visible assistant text; raw assistant events
      // duplicate it and can include text intentionally hidden from chat.
      if (event === "agent") {
        if (payload.stream === "assistant" || payload.stream === "thinking") {
          return true;
        }
        if (
          payload.stream === "item" &&
          isRecord(payload.data) &&
          payload.data.phase === "update" &&
          (payload.data.kind === "preamble" ||
            (payload.data.kind === "answer_candidate" && payload.data.status === "candidate"))
        ) {
          return true;
        }
      }
      if (typeof payload.sessionKey !== "string") {
        return false;
      }
      const projection = projectionFor(payload, payload.sessionKey, opts?.agentId);
      const key = projection.key;
      const pendingState = connections.get(client)?.sessions.get(key);
      if (
        pendingState?.pending &&
        ((typeof payload.runId === "string" &&
          payload.runId.trim().length > 0 &&
          payload.runId !== pendingState.pending.payload.runId) ||
          ((event === "agent" || event === "session.tool") &&
            payload.stream === "tool" &&
            isRecord(payload.data) &&
            typeof payload.data.name === "string" &&
            payload.data.name.trim().length > 0))
      ) {
        // Delayed text cannot overtake newer activity. Keep the existing pacing window.
        cancelPending(pendingState);
      }
      if (event !== "chat" || typeof payload.runId !== "string") {
        return false;
      }
      const delta = payload.state === "delta";
      const terminal =
        payload.state === "final" || payload.state === "error" || payload.state === "aborted";
      if (!delta && !terminal) {
        return false;
      }
      const connection = connectionFor(client);
      const state: NarrationState = connection.sessions.get(key) ?? {
        subscriptionKeys: sessionKeys,
      };
      state.subscriptionKeys = sessionKeys;
      connection.sessions.set(key, state);
      if (isRecord(payload.message)) {
        state.pending = { payload, projection, sessionKeys, opts };
      }
      if (terminal) {
        if (state.pending?.payload.runId === payload.runId) {
          flush(client, connection, state);
        }
      } else if (state.pending) {
        const delay = NARRATION_INTERVAL_MS - (Date.now() - (state.lastSentAt ?? -Infinity));
        if (delay <= 0) {
          flush(client, connection, state);
        } else if (!state.timer) {
          state.timer = setTimeout(() => flush(client, connection, state), delay);
          state.timer.unref?.();
        }
      }
      return delta;
    },
  };
}
