import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  MentionInboxItem,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";

type MentionsSnapshot = {
  phase: "unavailable" | "loading" | "ready" | "error";
  items: readonly MentionInboxItem[];
  dismissing: readonly string[];
  error: string | null;
};

export type MentionsCapability = {
  readonly snapshot: MentionsSnapshot;
  refresh: () => Promise<void>;
  dismiss: (ids: readonly string[]) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  subscribeArrivals: (listener: (items: readonly MentionInboxItem[]) => void) => () => void;
  dispose: () => void;
};

type MentionConnection = {
  client: GatewayBrowserClient;
  hello: GatewayHelloOk;
  connectionRevision: number;
  profileId: string;
  gatewayInstanceId: string;
  revision: number | null;
  requiredRevision: number | null;
  dismissing: Set<string>;
  seenArrivals: Map<string, number>;
  hasArrivalBaseline: boolean;
  refreshRequested: boolean;
  refreshPromise: Promise<void> | null;
};

/** Owns one profile's temporary Inbox even when no Inbox presenter is mounted. */
export function createMentionsCapability(
  gateway: ApplicationGateway,
  options: { connectionBootstrap?: ConnectionBootstrapCoordinator } = {},
): MentionsCapability {
  let snapshot: MentionsSnapshot = {
    phase: "unavailable",
    items: [],
    dismissing: [],
    error: null,
  };
  let connection: MentionConnection | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const arrivalListeners = new Set<(items: readonly MentionInboxItem[]) => void>();
  // The sidebar can hydrate before the lazy notification presenter subscribes.
  // Keep only arrival IDs; the current authorized Inbox owns their contents.
  const pendingArrivalIds = new Set<string>();
  const publish = (patch: Partial<MentionsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  };
  const isCurrent = (owner: MentionConnection) =>
    !disposed &&
    connection === owner &&
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
        (owner.revision !== null && result.revision < owner.revision)
      ) {
        return;
      }
      if (!owner.hasArrivalBaseline) {
        // Even an invalidated first read can identify retained IDs without
        // publishing stale contents. A first read already at the new revision
        // has no arrival boundary, so conservatively seed it without replay.
        for (const item of result.items) {
          owner.seenArrivals.set(item.id, item.expiresAt);
        }
        owner.hasArrivalBaseline = true;
      }
      if (owner.requiredRevision !== null && result.revision < owner.requiredRevision) {
        return;
      }
      const arrivals = result.items.filter((item) => !owner.seenArrivals.has(item.id)).toReversed();
      owner.revision = result.revision;
      const currentIds = new Set(result.items.map((item) => item.id));
      // Omission can mean a temporarily unreadable session, not a new arrival
      // when access returns. Retain IDs until their server-owned expiry; use
      // observed server creation times rather than the browser clock to prune.
      const observedTime = result.items.reduce((time, item) => Math.max(time, item.createdAt), 0);
      for (const [id, expiresAt] of owner.seenArrivals) {
        if (expiresAt <= observedTime && !currentIds.has(id)) {
          owner.seenArrivals.delete(id);
        }
      }
      for (const item of result.items) {
        owner.seenArrivals.set(item.id, item.expiresAt);
      }
      for (const id of pendingArrivalIds) {
        if (!currentIds.has(id)) {
          pendingArrivalIds.delete(id);
        }
      }
      publish({ phase: "ready", items: result.items, error: null });
      if (isCurrent(owner)) {
        if (arrivals.length) {
          if (!arrivalListeners.size) {
            for (const item of arrivals) {
              pendingArrivalIds.add(item.id);
            }
          }
          for (const listener of arrivalListeners) {
            listener(arrivals);
          }
        }
      }
    } catch (error) {
      if (!isCurrent(owner)) {
        return;
      }
      const accessLost =
        error instanceof GatewayRequestError &&
        (error.gatewayCode === "FORBIDDEN" ||
          resolveGatewayErrorDetailCode(error) ===
            ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE);
      if (accessLost) {
        // Retire in-flight reads too; an earlier success cannot restore a revoked Inbox.
        connection = null;
        pendingArrivalIds.clear();
      }
      publish({
        phase: "error",
        error: formatUiError(error),
        ...(accessLost ? { items: [], dismissing: [] } : {}),
      });
    }
  };

  const refreshOwner = (owner: MentionConnection): Promise<void> => {
    if (!isCurrent(owner)) {
      return Promise.resolve();
    }
    owner.refreshRequested = true;
    if (owner.refreshPromise) {
      return owner.refreshPromise;
    }
    owner.refreshPromise = Promise.resolve().then(async () => {
      try {
        while (isCurrent(owner) && owner.refreshRequested) {
          owner.refreshRequested = false;
          publish({ phase: "loading", error: null });
          await requestSnapshot(owner, "mentions.list", {});
          // An invalidation during a read gets one more authoritative snapshot;
          // revisions also fence an older read that finishes after dismissal.
        }
      } finally {
        owner.refreshPromise = null;
        if (isCurrent(owner) && owner.refreshRequested) {
          await refreshOwner(owner);
        }
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
      if (
        owner.revision !== null &&
        (owner.requiredRevision === null || owner.revision >= owner.requiredRevision)
      ) {
        owner.refreshRequested = false;
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
    pendingArrivalIds.clear();
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
      client: next.client,
      hello: next.hello,
      connectionRevision: gateway.connectionRevision,
      profileId,
      gatewayInstanceId,
      revision: null,
      requiredRevision: null,
      dismissing: new Set(),
      seenArrivals: new Map(),
      hasArrivalBaseline: false,
      refreshRequested: false,
      refreshPromise: null,
    };
    connection = owner;
    publish({ phase: "loading", items: [], dismissing: [], error: null });
    if (!isCurrent(owner)) {
      return;
    }
    void refreshAutomatically(owner);
  };

  // Subscribe before hydration so a commit cannot fall between the initial
  // snapshot and the profile's targeted invalidation stream.
  const stopEvents = gateway.subscribeEvents((event) => {
    const owner = connection;
    if (event.event !== "mentions.changed" || !owner || !isCurrent(owner)) {
      return;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (
      payload?.gatewayInstanceId !== owner.gatewayInstanceId ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0 ||
      (owner.revision !== null && payload.revision <= owner.revision)
    ) {
      return;
    }
    owner.requiredRevision = Math.max(owner.requiredRevision ?? 0, payload.revision);
    owner.refreshRequested = true;
    void refreshAutomatically(owner);
  });
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
    async dismiss(ids) {
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeArrivals(listener) {
      arrivalListeners.add(listener);
      if (pendingArrivalIds.size) {
        const currentItems = new Map(
          connection && isCurrent(connection) ? snapshot.items.map((item) => [item.id, item]) : [],
        );
        const arrivals = [...pendingArrivalIds].flatMap((id) => {
          const item = currentItems.get(id);
          return item ? [item] : [];
        });
        // Consume before calling: a synchronous subscription must not replay them.
        pendingArrivalIds.clear();
        if (arrivals.length) {
          listener(arrivals);
        }
      }
      return () => arrivalListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      connection = null;
      pendingArrivalIds.clear();
      stopGateway();
      stopEvents();
      listeners.clear();
      arrivalListeners.clear();
    },
  };
}
