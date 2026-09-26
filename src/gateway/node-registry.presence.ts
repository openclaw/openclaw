import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
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

export function selectActiveNode<T extends NodeSession>(nodes: readonly T[]): T | undefined {
  let active: T | undefined;
  for (const node of nodes) {
    if (node.lastActiveAtMs === undefined) {
      continue;
    }
    if (
      !active ||
      node.lastActiveAtMs > (active.lastActiveAtMs ?? 0) ||
      (node.lastActiveAtMs === active.lastActiveAtMs &&
        (node.presenceUpdatedAtMs ?? 0) > (active.presenceUpdatedAtMs ?? 0))
    ) {
      active = node;
    }
  }
  return active;
}

export function selectActiveNodesByProfile<T extends NodeSession>(
  nodes: readonly T[],
): Map<string | undefined, T> {
  const groups = new Map<string | undefined, T[]>();
  for (const node of nodes) {
    const authenticatedProfileId = node.client.authenticatedUserProfile?.profileId;
    const profileId =
      authenticatedProfileId === GATEWAY_OWNER_PROFILE_ID ? undefined : authenticatedProfileId;
    const group = groups.get(profileId);
    if (group) {
      group.push(node);
    } else {
      groups.set(profileId, [node]);
    }
  }
  const selected = new Map<string | undefined, T>();
  for (const [profileId, group] of groups) {
    const active = selectActiveNode(group);
    if (active) {
      selected.set(profileId, active);
    }
  }
  return selected;
}

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
  if (node.presenceActivitySource !== source) {
    node.lastActiveAtMs = lastActiveAtMs;
  } else if (params.saturated !== true || node.lastActiveAtMs === undefined) {
    node.lastActiveAtMs = Math.max(node.lastActiveAtMs ?? 0, lastActiveAtMs);
  }
  node.presenceActivitySource = source;
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
    (source === "system" && node.presenceActivitySource === "app") ||
    (node.lastActiveAtMs === undefined && node.presenceUpdatedAtMs === undefined)
  ) {
    return false;
  }
  node.lastActiveAtMs = undefined;
  node.presenceUpdatedAtMs = undefined;
  node.presenceActivitySource = undefined;
  return true;
}
