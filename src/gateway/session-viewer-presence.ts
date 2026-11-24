// Per-connection viewer presence declarations. Message subscriptions are transport state,
// while this replace-set records only the sessions a client is actually rendering.
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { upsertPresence } from "../infra/system-presence.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { buildClientPresence, recordClientPresenceActivity } from "./server/client-presence.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";

type SessionViewerPresenceDeclarationsDeps = {
  clients: GatewayClientRegistry;
  publishPresence: () => void;
};

/** Owns one replace-set per websocket connection until empty declaration or disconnect. */
export function createSessionViewerPresenceDeclarations(
  deps: SessionViewerPresenceDeclarationsDeps,
) {
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
    const next = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted();
    const previous = client.watchedSessions ?? [];
    if (previous.length === next.length && previous.every((key, index) => key === next[index])) {
      return next;
    }
    client.watchedSessions = next.length > 0 ? next : undefined;
    if (client.presenceKey) {
      upsertPresence(client.presenceKey, buildClientPresence(client));
      if (next.length > 0) {
        recordClientPresenceActivity(deps.clients, client);
      }
      deps.publishPresence();
    }
    return next;
  };

  const unsubscribe = (connId: string) => {
    const client = deps.clients.getByConnectionId(connId.trim());
    if (client) {
      // The close boundary clears the published row; retire its live declaration first.
      client.watchedSessions = undefined;
    }
  };

  /** True only while an open connection of this paired device currently renders the session. */
  const isViewedOnDevice = (deviceId: string, sessionKey: string): boolean => {
    if (stopped) {
      return false;
    }
    for (const client of deps.clients) {
      if (!client.watchedSessions?.includes(sessionKey)) {
        continue;
      }
      if (
        !client.invalidated &&
        !client.connectionSignal?.aborted &&
        client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
        normalizeOptionalString(client.connect.device?.id) === deviceId
      ) {
        return true;
      }
    }
    return false;
  };

  const stop = () => {
    stopped = true;
    for (const client of deps.clients) {
      client.watchedSessions = undefined;
    }
  };

  return { replace, unsubscribe, isViewedOnDevice, stop };
}

export type SessionViewerPresenceDeclarations = ReturnType<
  typeof createSessionViewerPresenceDeclarations
>;
