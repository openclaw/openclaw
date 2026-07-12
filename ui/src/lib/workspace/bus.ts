/** Parent-owned, in-memory pub/sub for custom widgets in one Workspaces view. */

export type WorkspaceWidgetBusConnection = {
  publish: (channel: string, payload: unknown) => number;
  subscribe: (channel: string, deliver: (channel: string, payload: unknown) => void) => () => void;
  dispose: () => void;
};

export type WorkspaceWidgetBus = {
  connect: (tabSlug: string) => WorkspaceWidgetBusConnection;
  /** Revoke connections whose tabs no longer exist in the workspace document. */
  retainTabs: (tabSlugs: ReadonlySet<string>) => void;
  /** Revoke every connection when the owning Workspaces view stops. */
  dispose: () => void;
};

type ConnectionState = {
  tabSlug: string;
  active: boolean;
  subscriptions: Map<string, (channel: string, payload: unknown) => void>;
};

/**
 * Create a broker scoped to one Workspaces view. Child messages never supply a
 * tab or subscriber id: the trusted parent closes over both in each connection.
 */
export function createWorkspaceWidgetBus(): WorkspaceWidgetBus {
  const connections = new Map<number, ConnectionState>();
  let nextConnectionId = 0;
  let active = true;

  const revoke = (connectionId: number): void => {
    const connection = connections.get(connectionId);
    if (!connection) {
      return;
    }
    connection.active = false;
    connection.subscriptions.clear();
    connections.delete(connectionId);
  };

  const connect = (tabSlug: string): WorkspaceWidgetBusConnection => {
    nextConnectionId += 1;
    const connectionId = nextConnectionId;
    const connection: ConnectionState = {
      tabSlug,
      active,
      subscriptions: new Map(),
    };
    if (active) {
      connections.set(connectionId, connection);
    }

    return {
      publish(channel, payload) {
        if (!active || !connection.active) {
          return 0;
        }
        let delivered = 0;
        // Snapshot before delivery so a callback can unsubscribe safely.
        for (const [peerId, peer] of Array.from(connections.entries())) {
          if (peerId === connectionId || !peer.active || peer.tabSlug !== connection.tabSlug) {
            continue;
          }
          const deliver = peer.subscriptions.get(channel);
          if (deliver) {
            deliver(channel, payload);
            delivered += 1;
          }
        }
        return delivered;
      },
      subscribe(channel, deliver) {
        if (!active || !connection.active) {
          return () => {};
        }
        connection.subscriptions.set(channel, deliver);
        return () => {
          if (connection.subscriptions.get(channel) === deliver) {
            connection.subscriptions.delete(channel);
          }
        };
      },
      dispose() {
        revoke(connectionId);
      },
    };
  };

  return {
    connect,
    retainTabs(tabSlugs) {
      for (const [connectionId, connection] of Array.from(connections.entries())) {
        if (!tabSlugs.has(connection.tabSlug)) {
          revoke(connectionId);
        }
      }
    },
    dispose() {
      if (!active) {
        return;
      }
      active = false;
      for (const connectionId of Array.from(connections.keys())) {
        revoke(connectionId);
      }
    },
  };
}
