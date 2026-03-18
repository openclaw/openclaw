import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

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

export type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;

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

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  // Per-client seq counter. Only incremented when an event is actually sent to
  // that client, so scope filtering and slow-consumer drops never cause gaps.
  const clientSeqs = new WeakMap<GatewayWsClient, number>();

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ) => {
    if (params.clients.size === 0) {
      return;
    }
    const isTargeted = Boolean(targetConnIds);
    const baseFrame = {
      type: "event" as const,
      event,
      payload,
      stateVersion: opts?.stateVersion,
    };
    let minSeq = Infinity;
    let maxSeq = -Infinity;
    let clientsSent = 0;
    for (const c of params.clients) {
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      if (!hasEventScope(c, event)) {
        continue;
      }
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      // Assign per-client seq only for non-targeted (broadcast) events.
      // Increment only after a successful send so failed sends don't create
      // seq gaps that trigger false "missed event" warnings on the client.
      const nextSeq = !isTargeted ? (clientSeqs.get(c) ?? 0) + 1 : undefined;
      try {
        c.socket.send(JSON.stringify({ ...baseFrame, seq: nextSeq }));
      } catch {
        // Send failed — skip seq increment so the counter stays consistent.
        continue;
      }
      if (nextSeq !== undefined) {
        clientSeqs.set(c, nextSeq);
        minSeq = Math.min(minSeq, nextSeq);
        maxSeq = Math.max(maxSeq, nextSeq);
      }
      clientsSent++;
    }
    if (shouldLogWs()) {
      const logMeta: Record<string, unknown> = {
        event,
        clients: params.clients.size,
        clientsSent,
        targets: targetConnIds ? targetConnIds.size : undefined,
        dropIfSlow: opts?.dropIfSlow,
        presenceVersion: opts?.stateVersion?.presence,
        healthVersion: opts?.stateVersion?.health,
      };
      if (!isTargeted && clientsSent > 0) {
        logMeta.minSeq = minSeq;
        logMeta.maxSeq = maxSeq;
      }
      if (event === "agent") {
        Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
      }
      logWs("out", "event", logMeta);
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) =>
    broadcastInternal(event, payload, opts);

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  return { broadcast, broadcastToConnIds };
}
