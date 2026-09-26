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
    activityAt < publication.at ||
    activityAt - publication.at >= ACTIVITY_BROADCAST_INTERVAL_MS;
  if (timing && activityAt !== undefined) {
    timing.lastActivityAt = activityAt;
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
    upsertPresence(peer.presenceKey!, {
      clientId: peer.connect.client.id,
      mode: peer.connect.client.mode,
      user: buildAuthenticatedPresenceUser(peer),
      ...peer.personPresence,
    });
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
