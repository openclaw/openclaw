import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  MentionInboxItem,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
} from "../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { resolveGatewayReadRetryDelayMs } from "../lib/gateway-availability.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { showToast } from "../lib/toast.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";

type MentionsSnapshot = {
  phase: "unavailable" | "loading" | "ready" | "error";
  items: readonly MentionInboxItem[];
  dismissing: readonly string[];
  error: string | null;
};

export type MentionsCapability = ReturnType<typeof createMentionsCapability>;

type MentionConnection = {
  retired: boolean;
  client: GatewayBrowserClient;
  hello: GatewayHelloOk;
  connectionRevision: number;
  profileId: string;
  gatewayInstanceId: string;
  revision: number;
  requestedRevision: number;
  dismissing: Set<string>;
  refreshRequested: boolean;
  refreshPromise: Promise<void> | null;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryAttempt: number;
};

/** Owns one profile's temporary Inbox even when no Inbox presenter is mounted. */
export function createMentionsCapability(
  gateway: ApplicationGateway,
  options: { connectionBootstrap?: ConnectionBootstrapCoordinator } = {},
) {
  let snapshot: MentionsSnapshot = {
    phase: "unavailable",
    items: [],
    dismissing: [],
    error: null,
  };
  let connection: MentionConnection | null = null;
  let disposed = false;
  const listeners = createChangeListeners();
  const publish = (patch: Partial<MentionsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.publish();
  };
  const isCurrent = (owner: MentionConnection) =>
    !disposed &&
    connection === owner &&
    !owner.retired &&
    canCallGatewayMethod(gateway.snapshot, "mentions.list", "operator.read") &&
    gateway.snapshot.client === owner.client &&
    gateway.snapshot.hello === owner.hello &&
    gateway.connectionRevision === owner.connectionRevision &&
    gateway.snapshot.selfUser?.identity?.id === owner.profileId;

  const requestSnapshot = async (
    owner: MentionConnection,
    method: "mentions.list" | "mentions.dismiss",
    params: { ids?: readonly string[] },
  ) => {
    if (!isCurrent(owner)) {
      return;
    }
    try {
      const result = await owner.client.request<MentionsListResult>(method, params);
      if (
        !isCurrent(owner) ||
        result.gatewayInstanceId !== owner.gatewayInstanceId ||
        result.revision < owner.revision
      ) {
        return;
      }
      owner.revision = result.revision;
      // The Gateway can emit its changed revision while preparing this same snapshot.
      owner.refreshRequested &&= owner.requestedRevision > result.revision;
      owner.retryAttempt = 0;
      publish({ phase: "ready", items: result.items, error: null });
    } catch (error) {
      if (!isCurrent(owner)) {
        return;
      }
      const accessLost =
        error instanceof GatewayRequestError &&
        (error.gatewayCode === "FORBIDDEN" ||
          resolveGatewayErrorDetailCode(error) ===
            ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE);
      if (error instanceof GatewayRequestError && error.gatewayCode === "UNAVAILABLE") {
        owner.refreshRequested = true;
        if (owner.retryTimer === undefined) {
          owner.retryTimer = setTimeout(
            () => {
              owner.retryTimer = undefined;
              void refreshAutomatically(owner);
            },
            resolveGatewayReadRetryDelayMs(error, owner.retryAttempt++),
          );
        }
      } else if (accessLost) {
        // Retire in-flight reads too; an earlier success cannot restore a revoked Inbox.
        clearTimeout(owner.retryTimer);
        connection = null;
      }
      publish({
        phase: "error",
        error: formatUiError(error),
        ...(accessLost ? { items: [], dismissing: [] } : {}),
      });
    }
  };

  const refreshOwner = (owner: MentionConnection): Promise<void> => {
    if (!isCurrent(owner) || owner.retryTimer !== undefined) {
      return Promise.resolve();
    }
    if (owner.refreshPromise) {
      return owner.refreshPromise;
    }
    owner.refreshRequested = true;
    owner.refreshPromise = Promise.resolve().then(async () => {
      try {
        while (isCurrent(owner) && owner.retryTimer === undefined && owner.refreshRequested) {
          owner.refreshRequested = false;
          publish({ phase: "loading", error: null });
          await requestSnapshot(owner, "mentions.list", {});
          // Events during a read request one follow-up snapshot.
        }
      } finally {
        owner.refreshPromise = null;
      }
    });
    return owner.refreshPromise;
  };

  const refreshAutomatically = (owner: MentionConnection): Promise<void> => {
    const hydrate = () => {
      if (!isCurrent(owner)) {
        return Promise.resolve();
      }
      if (owner.refreshPromise) {
        return owner.refreshPromise;
      }
      if (owner.revision >= 0 && !owner.refreshRequested) {
        return Promise.resolve();
      }
      return refreshOwner(owner);
    };
    return options.connectionBootstrap?.run(owner, hydrate, { background: true }) ?? hydrate();
  };

  const synchronize = () => {
    const next = gateway.snapshot;
    const profileId = next.selfUser?.identity?.id;
    const gatewayInstanceId = next.hello?.server?.bootId;
    if (connection && isCurrent(connection)) {
      return;
    }
    clearTimeout(connection?.retryTimer);
    if (connection) {
      // Keep its display identity, but never revive pre-disconnect requests.
      connection.retired = true;
    }
    const sameIdentity =
      connection?.client === next.client &&
      connection?.connectionRevision === gateway.connectionRevision &&
      (!profileId || connection.profileId === profileId) &&
      (!gatewayInstanceId || connection.gatewayInstanceId === gatewayInstanceId);
    if (!disposed && next.phase !== "connected" && sameIdentity) {
      publish({ phase: "unavailable", dismissing: [], error: null });
      return;
    }
    if (
      !disposed &&
      sameIdentity &&
      next.selfUser === undefined &&
      canCallGatewayMethod(next, "mentions.list", "operator.read")
    ) {
      // A fresh hello precedes users.self; unresolved identity is not access loss.
      publish({ phase: "loading", dismissing: [], error: null });
      return;
    }
    if (
      disposed ||
      next.phase !== "connected" ||
      !next.client ||
      !next.hello ||
      !profileId ||
      !gatewayInstanceId ||
      !canCallGatewayMethod(next, "mentions.list", "operator.read")
    ) {
      connection = null;
      publish({ phase: "unavailable", items: [], dismissing: [], error: null });
      return;
    }
    const owner: MentionConnection = {
      retired: false,
      client: next.client,
      hello: next.hello,
      connectionRevision: gateway.connectionRevision,
      profileId,
      gatewayInstanceId,
      revision: -1,
      requestedRevision: -1,
      dismissing: new Set(),
      refreshRequested: false,
      refreshPromise: null,
      retryAttempt: 0,
    };
    connection = owner;
    publish({
      phase: "loading",
      ...(!sameIdentity ? { items: [] } : {}),
      dismissing: [],
      error: null,
    });
    if (!isCurrent(owner)) {
      return;
    }
    void refreshAutomatically(owner);
  };

  // Subscribe before hydration so a commit cannot fall between the initial
  // snapshot and the profile's targeted invalidation stream.
  const stopEvents = gateway.subscribeEvents((event) => {
    const owner = connection;
    if (!owner || !isCurrent(owner)) {
      return;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (payload?.gatewayInstanceId !== owner.gatewayInstanceId) {
      return;
    }
    if (event.event === "mentions.failed") {
      if (
        typeof payload.errorMessage === "string" &&
        payload.errorMessage.length > 0 &&
        payload.errorMessage.length <= 512
      ) {
        showToast({ message: payload.errorMessage, durationMs: 10_000, fifo: true });
      }
      return;
    }
    if (
      event.event !== "mentions.changed" ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0 ||
      payload.revision <= Math.max(owner.revision, owner.requestedRevision)
    ) {
      return;
    }
    owner.requestedRevision = payload.revision;
    owner.refreshRequested = true;
    void refreshAutomatically(owner);
  });
  // Retire prior identity requests before hydrating the next connection's Inbox.
  const stopGateway = gateway.subscribe(synchronize);
  synchronize();

  return {
    get snapshot() {
      return snapshot;
    },
    refresh: () => {
      if (!connection) {
        synchronize();
      }
      return connection ? refreshOwner(connection) : Promise.resolve();
    },
    async dismiss(this: void, ids: readonly string[]) {
      const owner = connection;
      if (
        !owner ||
        !isCurrent(owner) ||
        !canCallGatewayMethod(gateway.snapshot, "mentions.dismiss", "operator.read")
      ) {
        return;
      }
      const visibleIds = new Set(snapshot.items.map((item) => item.id));
      const pendingIds = [...new Set(ids)].filter(
        (id) => visibleIds.has(id) && !owner.dismissing.has(id),
      );
      if (!pendingIds.length) {
        return;
      }
      for (const id of pendingIds) {
        owner.dismissing.add(id);
      }
      publish({ dismissing: [...owner.dismissing], error: null });
      try {
        await requestSnapshot(owner, "mentions.dismiss", { ids: pendingIds });
      } finally {
        for (const id of pendingIds) {
          owner.dismissing.delete(id);
        }
        if (isCurrent(owner)) {
          publish({ dismissing: [...owner.dismissing] });
        }
      }
    },
    subscribe: listeners.subscribe,
    dispose() {
      disposed = true;
      clearTimeout(connection?.retryTimer);
      connection = null;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}
