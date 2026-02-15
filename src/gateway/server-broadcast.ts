import { WebSocket } from "ws";
import type { GatewayWsClient, GatewayWsSendState, PendingWsFrame } from "./server/ws-types.js";
import {
  MAX_BUFFERED_BYTES,
  WS_BATCH_FLUSH_MS,
  WS_MAX_FRAME_BYTES,
  WS_MAX_QUEUE,
  WS_SLOW_BUFFER_STRIKES,
  WS_TRUNCATE_PREVIEW_BYTES,
} from "./server-constants.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  return required.some((scope) => scopes.includes(scope));
}

const NON_CRITICAL_TYPES = new Set([
  "log",
  "debug",
  "progress",
  "token_delta",
  "trace",
  "playwright_event",
]);

const CRITICAL_TYPES = new Set([
  "job_started",
  "job_finished",
  "error",
  "final_result",
  "post_published",
]);

type FrameMeta = {
  messageType?: string;
  droppable: boolean;
  critical: boolean;
  truncated?: boolean;
};

function classifyPayload(payload: unknown): FrameMeta {
  const typeCandidate = (val: unknown) =>
    typeof val === "string" && val.trim() ? val.trim().toLowerCase() : "";

  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const messageType =
    typeCandidate(payloadObj?.type) ||
    typeCandidate((payloadObj?.data as Record<string, unknown> | undefined)?.type) ||
    typeCandidate(payloadObj?.stream);

  const droppable = messageType ? NON_CRITICAL_TYPES.has(messageType) : false;
  const critical = messageType ? CRITICAL_TYPES.has(messageType) : false;

  return { messageType: messageType || undefined, droppable, critical };
}

function truncatePayload(payload: unknown): {
  truncated: true;
  preview: string;
  originalBytes: number;
  refId?: string;
} {
  const raw = JSON.stringify(payload);
  const originalBytes = Buffer.byteLength(raw);
  const preview = raw.slice(0, WS_TRUNCATE_PREVIEW_BYTES);
  const refId =
    payload &&
    typeof payload === "object" &&
    typeof (payload as { refId?: unknown }).refId === "string"
      ? (payload as { refId: string }).refId
      : undefined;
  return {
    truncated: true,
    preview,
    originalBytes,
    refId,
  } as const;
}

const stateByClient = new WeakMap<GatewayWsClient, GatewayWsSendState>();

function getState(client: GatewayWsClient): GatewayWsSendState {
  const existing = stateByClient.get(client);
  if (existing) {
    return existing;
  }
  const created: GatewayWsSendState = {
    queue: [],
    flushTimer: null,
    dropped: 0,
    truncated: 0,
    batches: 0,
    slowStrikes: 0,
    lastLogTs: 0,
  };
  stateByClient.set(client, created);
  return created;
}

function logMetrics(client: GatewayWsClient, state: GatewayWsSendState) {
  const now = Date.now();
  if (now - state.lastLogTs < 2000) {
    return;
  }
  state.lastLogTs = now;
  logWs("out", "ws-metrics", {
    connId: client.connId,
    ws_queue_len: state.queue.length,
    ws_dropped: state.dropped,
    ws_truncated: state.truncated,
    ws_batches_sent: state.batches,
  });
}

function prepareFrame(
  event: string,
  payload: unknown,
  seq?: number,
  stateVersion?: { presence?: number; health?: number },
): {
  frame: PendingWsFrame;
  meta: FrameMeta;
} {
  const meta = classifyPayload(payload);
  const envelope = {
    type: "event",
    event,
    payload,
    seq,
    stateVersion,
  };
  let json = JSON.stringify(envelope);
  let truncated = false;

  if (Buffer.byteLength(json) > WS_MAX_FRAME_BYTES) {
    const safePayload = truncatePayload(payload);
    const truncatedEnvelope = { ...envelope, payload: safePayload };
    json = JSON.stringify(truncatedEnvelope);
    truncated = true;
  }

  return {
    meta: { ...meta, truncated },
    frame: {
      event,
      json,
      size: Buffer.byteLength(json),
      messageType: meta.messageType,
      droppable: meta.droppable,
      critical: meta.critical,
      truncated,
    },
  };
}

function scheduleFlush(client: GatewayWsClient, state: GatewayWsSendState) {
  if (state.flushTimer) {
    return;
  }
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    flushClient(client, state);
    if (state.queue.length > 0) {
      scheduleFlush(client, state);
    }
  }, WS_BATCH_FLUSH_MS);
}

function flushClient(client: GatewayWsClient, state: GatewayWsSendState) {
  if (client.socket.readyState !== WebSocket.OPEN) {
    state.queue.length = 0;
    return;
  }
  const buffered = client.socket.bufferedAmount;
  if (buffered > MAX_BUFFERED_BYTES) {
    state.slowStrikes += 1;
    logWs("out", "ws-backpressure", {
      connId: client.connId,
      buffered,
      strikes: state.slowStrikes,
      queue: state.queue.length,
    });
    if (state.slowStrikes >= WS_SLOW_BUFFER_STRIKES) {
      try {
        client.socket.close(1008, "slow consumer");
      } catch {
        /* ignore */
      }
    } else {
      scheduleFlush(client, state);
    }
    return;
  }

  state.slowStrikes = 0;
  if (state.queue.length === 0) {
    return;
  }

  const frames = state.queue.splice(0, WS_MAX_QUEUE);
  state.batches += 1;
  for (const frame of frames) {
    try {
      client.socket.send(frame.json);
    } catch {
      /* ignore */
    }
  }
  logMetrics(client, state);
}

function mergeOrDrop(state: GatewayWsSendState, next: PendingWsFrame): boolean {
  // Drop immediately when queue is saturated and frame is droppable.
  if (state.queue.length >= WS_MAX_QUEUE && next.droppable) {
    state.dropped += 1;
    return true;
  }

  const highWaterMark = Math.floor(WS_MAX_QUEUE * 0.6);
  if (next.droppable && state.queue.length >= highWaterMark) {
    // Replace the latest pending frame of the same type/event to compact bursts.
    for (let i = state.queue.length - 1; i >= 0; i -= 1) {
      const candidate = state.queue[i];
      if (
        candidate.droppable &&
        candidate.event === next.event &&
        candidate.messageType === next.messageType
      ) {
        state.queue[i] = next;
        state.dropped += 1;
        return true;
      }
    }
  }

  if (state.queue.length >= WS_MAX_QUEUE) {
    // Remove the oldest droppable frame to make room.
    const idx = state.queue.findIndex((f) => f.droppable && !f.critical);
    if (idx >= 0) {
      state.queue.splice(idx, 1);
      state.dropped += 1;
      return false;
    }
    // No droppable frame to evict — replace the oldest frame (keep latest events moving).
    state.queue.shift();
    state.dropped += 1;
    return false;
  }

  return false;
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
    targetConnIds?: ReadonlySet<string>,
  ) => {
    const isTargeted = Boolean(targetConnIds);
    const eventSeq = isTargeted ? undefined : ++seq;

    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq ?? "targeted",
      clients: params.clients.size,
      targets: targetConnIds ? targetConnIds.size : undefined,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);

    const preparedByClient: Array<{
      client: GatewayWsClient;
      frame: PendingWsFrame;
      meta: FrameMeta;
    }> = [];

    for (const c of params.clients) {
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      if (!hasEventScope(c, event)) {
        continue;
      }

      const { frame, meta } = prepareFrame(event, payload, eventSeq, opts?.stateVersion);
      if (meta.truncated) {
        const state = getState(c);
        state.truncated += 1;
      }
      preparedByClient.push({ client: c, frame, meta });
    }

    for (const entry of preparedByClient) {
      const { client, frame } = entry;
      const state = getState(client);
      if (mergeOrDrop(state, frame)) {
        logMetrics(client, state);
        continue;
      }
      state.queue.push(frame);
      scheduleFlush(client, state);
      logMetrics(client, state);
    }
  };

  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => broadcastInternal(event, payload, opts);

  const broadcastToConnIds = (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  return { broadcast, broadcastToConnIds };
}
