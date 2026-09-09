// Per-connection viewer presence declarations. Message subscriptions are transport state,
// while this replace-set records only the sessions a client is actually rendering.
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { upsertPresence } from "../infra/system-presence.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { recordClientPresenceActivity } from "./server/client-presence.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type SessionViewerPresenceDeclarationsDeps = Parameters<typeof broadcastPresenceSnapshot>[0] & {
  clients: GatewayClientRegistry;
};

type SessionViewerPresenceDeclarations = {
  replace: (connId: string, sessionKeys: readonly string[]) => readonly string[];
  unsubscribe: (connId: string) => void;
  stop: () => void;
};

function normalizedSessionKeys(sessionKeys: readonly string[]): string[] {
  return [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted();
}

function sameKeys(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

/** Owns one replace-set per websocket connection until empty declaration or disconnect. */
export function createSessionViewerPresenceDeclarations(
  deps: SessionViewerPresenceDeclarationsDeps,
): SessionViewerPresenceDeclarations {
  const declarations = new Map<
    string,
    { client: GatewayWsClient; sessionKeys: readonly string[] }
  >();
  let stopped = false;

  const replace = (connId: string, sessionKeys: readonly string[]): readonly string[] => {
    if (stopped) {
      return [];
    }
    const normalizedConnId = connId.trim();
    const client = deps.clients.getByConnectionId(normalizedConnId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return [];
    }
    const next = normalizedSessionKeys(sessionKeys);
    const previous = declarations.get(normalizedConnId)?.sessionKeys;
    client.sessionViewerLease =
      next.length > 0
        ? { sessionKeys: next, expiresAt: Date.now() + SESSION_VIEWER_LEASE_MS }
        : undefined;
    if (sameKeys(previous, next) || (previous === undefined && next.length === 0)) {
      return next;
    }
    if (next.length === 0) {
      declarations.delete(normalizedConnId);
    } else {
      declarations.set(normalizedConnId, { client, sessionKeys: next });
    }
    if (client.presenceKey) {
      upsertPresence(client.presenceKey, {
        watchedSessions: next.length > 0 ? [...next] : undefined,
      });
      if (next.length > 0) {
        recordClientPresenceActivity(deps.clients, client);
      }
      broadcastPresenceSnapshot(deps);
    }
    return next;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (normalizedConnId) {
      // The websocket close boundary publishes reason=disconnect and clears watchedSessions.
      // Delete here first so a recycled connection id can never inherit an old declaration.
      const declaration = declarations.get(normalizedConnId);
      if (declaration) declaration.client.sessionViewerLease = undefined;
      declarations.delete(normalizedConnId);
    }
  };

  const stop = () => {
    stopped = true;
    for (const declaration of declarations.values())
      declaration.client.sessionViewerLease = undefined;
    declarations.clear();
  };

  return { replace, unsubscribe, stop };
}

const SESSION_VIEWER_LEASE_MS = 30_000;

/** Fail open to notifications unless the same authenticated human is viewing this exact session. */
export function shouldSuppressAndroidChatNotification(
  clients: ReadonlySet<GatewayWsClient>,
  recipient: GatewayWsClient,
  sessionKey: unknown,
): boolean {
  const profileId = recipient.authenticatedUserProfile?.profileId;
  if (
    !profileId ||
    recipient.connect.client?.id !== GATEWAY_CLIENT_IDS.ANDROID_APP ||
    (recipient.connect.role ?? "operator") !== "operator" ||
    typeof sessionKey !== "string" ||
    !parseAgentSessionKey(sessionKey)
  )
    return false;
  // Raw aliases such as main cannot be mapped without runtime agent configuration. Never guess.
  const now = Date.now();
  for (const viewer of clients) {
    if (
      viewer !== recipient &&
      !viewer.invalidated &&
      viewer.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
      viewer.connect.client?.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
      (viewer.connect.role ?? "operator") === "operator" &&
      viewer.authenticatedUserProfile?.profileId === profileId &&
      viewer.sessionViewerLease &&
      viewer.sessionViewerLease.expiresAt > now &&
      viewer.sessionViewerLease.sessionKeys.includes(sessionKey)
    )
      return true;
  }
  return false;
}
