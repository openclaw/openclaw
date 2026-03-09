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
  let seq = 0;

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
    const eventSeq = isTargeted ? undefined : ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    if (shouldLogWs()) {
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
    }
    // [DEBUG] Log broadcast events (skip tick and assistant text-delta to reduce noise)
    const debugSkip =
      event === "tick" ||
      (event === "agent" && (payload as Record<string, unknown> | null)?.stream === "assistant");
    if (!debugSkip) {
      const agentSummary = event === "agent" ? summarizeAgentEventForWsLog(payload) : {};
      const payloadPreview =
        event === "agent"
          ? JSON.stringify(agentSummary)
          : JSON.stringify(payload ?? null).slice(0, 300);
      console.log(
        `[WS:DEBUG] \u2500\u2500 BROADCAST \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      );
      console.log(`[WS:DEBUG] event    = ${event}`);
      console.log(`[WS:DEBUG] seq      = ${eventSeq ?? "targeted"}`);
      console.log(`[WS:DEBUG] clients  = ${params.clients.size}`);
      console.log(`[WS:DEBUG] payload  = ${payloadPreview}`);
    }
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
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
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
