import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import { upsertPresence } from "../../infra/system-presence.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../server-constants.js";
import type { GatewayClient } from "../server-methods/types.js";
import type { GatewayClientRegistry } from "./client-registry.js";
import type { GatewayWsClient } from "./ws-types.js";

const ACTIVITY_BROADCAST_INTERVAL_MS = 30_000;
const activityPublications = new WeakMap<GatewayWsClient, { identity: string; at: number }>();

function isLiveClient(client: GatewayWsClient): boolean {
  return !client.invalidated && client.socket.readyState === WEBSOCKET_OPEN_READY_STATE;
}

function presenceIdentity(client: GatewayWsClient): string | undefined {
  const profileId = client.authenticatedUserProfile?.profileId;
  return profileId
    ? presenceUserKey({ id: profileId, identity: { type: "profile", id: profileId } })
    : client.authenticatedUserId && !client.authenticatedGitHubIdentitySync
      ? presenceUserKey({ id: client.authenticatedUserId })
      : undefined;
}

/** Rebuild evicted rows from their live owner, including explicit clears of old facts. */
export function buildClientPresence(
  client: GatewayWsClient,
  observedAt = Date.now(),
): PresenceEntry {
  const { connect } = client;
  const role = connect.role ?? "operator";
  return {
    connectionId: client.connId,
    deviceId: connect.device?.id,
    instanceId:
      role === "node"
        ? (connect.device?.id ?? connect.client.instanceId)
        : connect.client.instanceId,
    host: connect.client.displayName ?? connect.client.id,
    clientId: connect.client.id,
    version: connect.client.version,
    platform: connect.client.platform,
    deviceFamily: connect.client.deviceFamily,
    modelIdentifier: connect.client.modelIdentifier,
    timeZone: connect.client.timeZone,
    mode: connect.client.mode,
    ip: client.internal?.isLocalClient ? undefined : client.clientIp,
    roles: [role],
    scopes: connect.scopes,
    user: presenceIdentity(client) ? buildAuthenticatedPresenceUser(client) : undefined,
    watchedSessions: client.watchedSessions?.length ? [...client.watchedSessions] : undefined,
    onlineSince: client.personPresence?.onlineSince,
    lastActivityAt: client.personPresence?.lastActivityAt,
    connectionLastActivityAt: client.connectionLastActivityAt,
    ts: observedAt,
  };
}

/** Current transport facts are complete even when the legacy beacon cache evicts a row. */
export function snapshotClientPresence(
  clients: ReadonlySet<GatewayWsClient>,
  observedAt = Date.now(),
): PresenceEntry[] {
  return [...clients]
    .filter((client) => client.presenceKey && isLiveClient(client))
    .map((client) => buildClientPresence(client, observedAt));
}

/** Reconciles live identity/timing and returns whether a presence snapshot is needed. */
export function refreshClientPresence(
  clients: ReadonlySet<GatewayWsClient>,
  client: GatewayWsClient,
  activityAt?: number,
): boolean {
  if (!clients.has(client) || !isLiveClient(client) || !client.presenceKey) {
    return false;
  }
  const identity = presenceIdentity(client);
  if (!identity) {
    return false;
  }
  const peers = [...clients].filter(
    (peer) =>
      isLiveClient(peer) &&
      peer.presenceKey &&
      presenceIdentity(peer) === identity &&
      (peer === client || (client.personPresence && peer.personPresence)),
  );
  const timing = client.personPresence ? { ...client.personPresence } : undefined;
  for (const peer of peers) {
    if (timing && peer.personPresence) {
      timing.onlineSince = Math.min(timing.onlineSince, peer.personPresence.onlineSince);
      const activity = peer.personPresence.lastActivityAt;
      if (activity !== undefined) {
        timing.lastActivityAt = Math.max(timing.lastActivityAt ?? activity, activity);
      }
    }
  }
  const publication = activityPublications.get(client);
  const publish =
    activityAt === undefined ||
    timing?.lastActivityAt === undefined ||
    publication?.identity !== identity ||
    activityAt - publication.at >= ACTIVITY_BROADCAST_INTERVAL_MS;
  if (timing && activityAt !== undefined) {
    timing.lastActivityAt = activityAt;
    client.connectionLastActivityAt = activityAt;
  }
  // Keep exact activity in the store; only publication is coalesced. Share the
  // window across live peers, with weak keys so a full reconnect starts fresh.
  const nextPublication = publish
    ? { identity, at: activityAt ?? timing?.lastActivityAt ?? Date.now() }
    : publication;
  for (const peer of peers) {
    // Copy interval facts so later profile qualification cannot leave raw and
    // profile sockets sharing mutable activity. Nodes retain their device lifecycle.
    if (timing && peer.personPresence) {
      peer.personPresence = { ...timing };
    }
    if (nextPublication) {
      activityPublications.set(peer, nextPublication);
    }
    upsertPresence(peer.presenceKey!, buildClientPresence(peer));
  }
  return publish;
}

/** Records accepted human activity; copies and clients closed during admission cannot write. */
export function recordClientPresenceActivity(
  clients: GatewayClientRegistry,
  client: GatewayClient | null,
): boolean {
  const live = client?.connId ? clients.getByConnectionId(client.connId) : undefined;
  return Boolean(
    live &&
    live === client &&
    live.personPresence &&
    refreshClientPresence(clients, live, Date.now()),
  );
}
