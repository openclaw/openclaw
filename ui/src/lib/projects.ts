import type { ProjectsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

type ProjectCatalogSnapshot = {
  result: ProjectsListResult | null;
  ready: boolean;
  /** Set when the latest projects.list failed and the catalog has settled. */
  error: unknown;
};
export type ProjectCatalog = {
  readonly snapshot: ProjectCatalogSnapshot;
  readonly loading: boolean;
  readonly pendingRead: Promise<void> | null;
  subscribe: (listener: () => void) => () => void;
  refresh: (invalidate?: boolean) => Promise<void>;
};

const catalogs = new WeakMap<ApplicationGateway, ProjectCatalog>();

export function projectsForGateway(gateway: ApplicationGateway): ProjectCatalog {
  const existing = catalogs.get(gateway);
  if (existing) {
    return existing;
  }
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  const listeners = new Set<() => void>();
  let snapshot: ProjectCatalogSnapshot = { result: null, ready: false, error: null };
  let signature = "";
  let client = gateway.snapshot.client;
  let presentationKey = gatewayPresentationScope(gateway).key;
  let pending: Promise<void> | null = null;
  let unsubscribe: (() => void) | undefined;
  const retire = () => {
    connection.invalidate();
    pending = null;
    snapshot = { result: null, ready: false, error: null };
  };
  const notify = () => listeners.forEach((listener) => listener());
  const synchronize = () => {
    const next = gateway.snapshot;
    const nextPresentationKey = gatewayPresentationScope(gateway).key;
    const nextSignature =
      next.phase === "connected"
        ? JSON.stringify([
            gateway.connection.gatewayUrl,
            gateway.connectionRevision,
            nextPresentationKey,
            next.hello?.auth?.role,
            [...(next.hello?.auth?.scopes ?? [])].toSorted(),
            canCallGatewayMethod(next, "projects.list", "operator.read"),
          ])
        : signature;
    const transitioned = connection.transition(next);
    const identityChanged =
      client !== next.client ||
      nextSignature !== signature ||
      presentationKey !== nextPresentationKey;
    client = next.client;
    presentationKey = nextPresentationKey;
    if (transitioned || identityChanged) {
      signature = nextSignature;
      pending = null;
      if (identityChanged) {
        retire();
      }
      return true;
    }
    return false;
  };
  const refresh = (invalidate = false): Promise<void> => {
    synchronize();
    if (invalidate) {
      retire();
      notify();
    }
    if (pending) {
      return pending;
    }
    const scope = connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    if (!canCallGatewayMethod(gateway.snapshot, "projects.list", "operator.read")) {
      snapshot = { result: { projects: [] }, ready: true, error: null };
      notify();
      return Promise.resolve();
    }
    const request = scope.client
      .request<ProjectsListResult>("projects.list", {})
      .then(
        (result) => {
          synchronize();
          if (!connection.isCurrent(scope)) {
            return;
          }
          snapshot = {
            result,
            ready: true,
            error: null,
          };
        },
        (error: unknown) => {
          synchronize();
          if (!connection.isCurrent(scope)) {
            return;
          }
          // ready means a successful list. Preference restore treats that as
          // the authoritative catalog and would drop a saved project if a
          // failed first read were marked ready.
          snapshot = {
            result: snapshot.result,
            ready: snapshot.ready && snapshot.result !== null,
            error,
          };
        },
      )
      .finally(() => {
        if (pending === request) {
          pending = null;
          notify();
        }
      });
    pending = request;
    notify();
    return request;
  };
  const catalog: ProjectCatalog = {
    get snapshot() {
      if (synchronize() && listeners.size) {
        void refresh();
      }
      return snapshot;
    },
    get loading() {
      return pending !== null;
    },
    get pendingRead() {
      return pending;
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        // Gateway receipts refresh the shared authorized project catalog for New Session and cold chat.
        const unsubscribeGateway = gateway.subscribe(() => {
          if (synchronize()) {
            notify();
            void refresh();
          }
        });
        const unsubscribeEvents = gateway.subscribeEvents((event) => {
          if (event.event === "config.changed") {
            void refresh(true);
          }
        });
        unsubscribe = () => {
          unsubscribeGateway();
          unsubscribeEvents();
        };
      }
      synchronize();
      if (!snapshot.ready) {
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = undefined;
          retire();
        }
      };
    },
  };
  catalogs.set(gateway, catalog);
  return catalog;
}
