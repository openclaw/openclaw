import type { GatewayBrowserClient } from "../api/gateway.ts";
import { listen } from "../lib/reactive/listener.ts";
import {
  LINK_READER_METADATA_REQUEST_EVENT,
  LINK_READER_METADATA_UPDATED_EVENT,
  type LinkReaderMetadataUpdate,
} from "./link-reader-response.ts";

type MetadataListener = (update: LinkReaderMetadataUpdate) => void;
type MetadataSessions = Map<string, Set<MetadataListener>>;
type MetadataAgents = Map<string | undefined, MetadataSessions>;
type MetadataOwner = {
  clients: Map<GatewayBrowserClient | null, MetadataAgents>;
  stop: () => void;
  requestQueued: boolean;
};
const owners = new WeakMap<Window, MetadataOwner>();

/** Routes committed metadata; providers still validate reader membership and live context. */
export function subscribeLinkReaderMetadata(
  window: Window,
  scope: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    sessionKey: string | undefined;
  },
  listener: MetadataListener,
): () => void {
  let owner = owners.get(window);
  if (!owner) {
    const clients: MetadataOwner["clients"] = new Map();
    owner = {
      clients,
      requestQueued: false,
      stop: listen(window, LINK_READER_METADATA_UPDATED_EVENT, (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        const update = event.detail;
        const listeners = clients
          .get(update.client)
          ?.get(update.agentId)
          ?.get(update.sessionKey ?? "");
        if (!listeners) {
          return;
        }
        for (const callback of Array.from(listeners)) {
          if (listeners.has(callback)) {
            try {
              callback(update);
            } catch (error) {
              reportError(error);
            }
          }
        }
      }),
    };
    owners.set(window, owner);
  }
  const current = owner;
  // Capture registration identity: callers rebind when any routing input changes.
  const { client, agentId } = scope;
  const sessionKey = scope.sessionKey ?? "";
  let agents = current.clients.get(client);
  if (!agents) {
    agents = new Map();
    current.clients.set(client, agents);
  }
  let sessions = agents.get(agentId);
  if (!sessions) {
    sessions = new Map();
    agents.set(agentId, sessions);
  }
  let listeners = sessions.get(sessionKey);
  if (!listeners) {
    listeners = new Set();
    sessions.set(sessionKey, listeners);
  }
  const entry: MetadataListener = (update) => listener(update);
  listeners.add(entry);
  return () => {
    if (!listeners.delete(entry)) {
      return;
    }
    if (listeners.size === 0) {
      sessions.delete(sessionKey);
      if (sessions.size === 0) {
        agents.delete(agentId);
        if (agents.size === 0) {
          current.clients.delete(client);
        }
      }
    }
    if (current.clients.size === 0) {
      current.stop();
      owners.delete(window);
    }
  };
}

/** A mounting batch needs one replay from panels, not one replay per provider. */
export function requestLinkReaderMetadata(window: Window): void {
  const owner = owners.get(window);
  if (!owner || owner.requestQueued) {
    return;
  }
  owner.requestQueued = true;
  queueMicrotask(() => {
    if (owners.get(window) !== owner) {
      return;
    }
    owner.requestQueued = false;
    window.dispatchEvent(new Event(LINK_READER_METADATA_REQUEST_EVENT));
  });
}
