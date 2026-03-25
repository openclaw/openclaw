import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
} from "./method-scopes.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  "sessions.changed": [READ_SCOPE],
  "session.message": [READ_SCOPE],
  "session.tool": [READ_SCOPE],
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
  if (required.includes(READ_SCOPE)) {
    return scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return required.some((scope) => scopes.includes(scope));
}

/**
 * Derive a stable identity key for a client that persists across WebSocket
 * reconnects.  The browser control UI keeps `lastSeq` across its built-in
 * auto-reconnect, so the server must continue the sequence rather than
 * restarting at 1 — otherwise the backward jump is silently ignored and
 * events missed during the outage become invisible.
 *
 * Key composition: `client.id` (e.g. "openclaw-control-ui") is always
 * present; `client.instanceId` disambiguates multiple tabs/windows of the
 * same client type.  Falls back to the ephemeral `connId` when neither is
 * available (nodes, CLI clients without instanceId).
 */
function seqKey(c: GatewayWsClient): string {
  const inst = c.connect.client.instanceId;
  return inst ? `${c.connect.client.id}::${inst}` : c.connId;
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  // --- Seq tracking (two-layer design) ---
  //
  // Layer 1 — per-socket live counter (WeakMap).  Each GatewayWsClient gets
  // its own independent sequence so concurrent sockets with the same identity
  // (e.g. half-open TCP + fresh reconnect) never alias each other's counters.
  //
  // Layer 2 — identity high-water mark (Map<string, number>).  Stores the
  // highest seq ever delivered/dropped for a given stable client identity.
  // When a *new* socket is first seen, it inherits this value so its sequence
  // continues forward from where the previous socket left off — the browser
  // client keeps lastSeq across auto-reconnects and only triggers onGap for
  // forward jumps.
  //
  // Seq is advanced when an event is sent *or* intentionally dropped via
  // dropIfSlow.  Scope-filtered skips (client never subscribed) do not
  // advance seq.
  const liveSeqs = new WeakMap<GatewayWsClient, number>();
  const highWaterByIdentity = new Map<string, number>();
  const keyCache = new WeakMap<GatewayWsClient, string>();

  function resolveKey(c: GatewayWsClient): string {
    let key = keyCache.get(c);
    if (key === undefined) {
      key = seqKey(c);
      keyCache.set(c, key);
    }
    return key;
  }

  function advanceSeq(c: GatewayWsClient): number {
    let prev = liveSeqs.get(c);
    if (prev === undefined) {
      // First broadcast to this socket — inherit the identity high-water mark
      // so the reconnecting client sees a forward seq jump (not a reset to 1).
      const key = resolveKey(c);
      prev = highWaterByIdentity.get(key) ?? 0;
    }
    const next = prev + 1;
    liveSeqs.set(c, next);
    // Update high-water mark for future reconnects.
    const key = resolveKey(c);
    const hw = highWaterByIdentity.get(key) ?? 0;
    if (next > hw) {
      highWaterByIdentity.set(key, next);
    }
    return next;
  }

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
        // Advance seq without sending so the client detects a gap via onGap.
        // This is intentional: dropIfSlow events (e.g. exec.approval.requested)
        // are stateful, and the UI relies on gap detection to surface stale state.
        if (!isTargeted) {
          advanceSeq(c);
        }
        continue;
      }
      if (slow) {
        // Advance seq before disconnecting so the reconnecting client sees a
        // forward gap and triggers onGap.  The old global ++seq advanced before
        // the buffer check, so omitting this would be a regression.
        if (!isTargeted) {
          advanceSeq(c);
        }
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      // Assign per-client seq only for non-targeted (broadcast) events.
      // Use a local variable + spread to avoid mutating a shared object,
      // which would silently break if the loop body ever became async.
      const clientSeq = !isTargeted ? advanceSeq(c) : undefined;
      if (clientSeq !== undefined) {
        minSeq = Math.min(minSeq, clientSeq);
        maxSeq = Math.max(maxSeq, clientSeq);
      }
      clientsSent++;
      try {
        c.socket.send(JSON.stringify({ ...baseFrame, seq: clientSeq }));
      } catch {
        /* ignore */
      }
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
