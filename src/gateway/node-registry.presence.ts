import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import type { NodeSession } from "./node-session.types.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";

export type NodePresenceActivityUpdate = {
  nodeId: string;
  connId?: string;
  idleSeconds: number;
  source?: "app" | "system";
  saturated?: boolean;
  observedAtMs?: number;
};

// Source follows the exact live session, never a node id reused after reconnect.
const presenceSources = new WeakMap<NodeSession, "app" | "system">();

export function updateNodePresenceActivity(
  node: NodeSession | undefined,
  params: NodePresenceActivityUpdate,
): NodeSession | null {
  const source = params.source ?? "system";
  if (
    !node ||
    !params.connId ||
    node.connId !== params.connId ||
    node.client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE
  ) {
    return null;
  }
  if (source === "app") {
    if (
      node.clientId !== GATEWAY_CLIENT_IDS.MACOS_APP ||
      node.clientMode !== "node" ||
      !/^(?:darwin|macos(?: \d+(?:\.\d+){0,2})?)$/i.test(node.platform ?? "")
    ) {
      return null;
    }
  } else if (node.permissions?.accessibility !== true) {
    return null;
  }
  const observedAtMs = params.observedAtMs ?? Date.now();
  const lastActiveAtMs = Math.max(0, observedAtMs - params.idleSeconds * 1000);
  // App fallback replaces system history; otherwise a disabled system sample
  // could keep this Mac selected after the reporter switches to app-only input.
  if (presenceSources.get(node) !== source) {
    node.lastActiveAtMs = lastActiveAtMs;
  } else if (params.saturated !== true || node.lastActiveAtMs === undefined) {
    node.lastActiveAtMs = Math.max(node.lastActiveAtMs ?? 0, lastActiveAtMs);
  }
  presenceSources.set(node, source);
  node.presenceUpdatedAtMs = observedAtMs;
  return node;
}

export function clearNodePresenceActivity(
  node: NodeSession | undefined,
  connId?: string,
  source?: "system",
): boolean | null {
  if (!node || !connId || node.connId !== connId) {
    return null;
  }
  if (
    (source === "system" && presenceSources.get(node) === "app") ||
    (node.lastActiveAtMs === undefined && node.presenceUpdatedAtMs === undefined)
  ) {
    return false;
  }
  node.lastActiveAtMs = undefined;
  node.presenceUpdatedAtMs = undefined;
  presenceSources.delete(node);
  return true;
}
