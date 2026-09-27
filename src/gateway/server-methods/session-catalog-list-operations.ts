import type {
  SessionCatalog,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { capturePluginRegistryLifecycleEpoch } from "../../plugins/registry-lifecycle.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayClient } from "./types.js";

export type CatalogListEnumeration = {
  catalogs: SessionCatalog[];
  instancesByCatalog: Map<string, SessionCatalogInstances>;
  publishedHosts?: Map<string, Map<string, SessionCatalog["hosts"][number]>>;
};

type CatalogListOperation = {
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListOperations = {
  registrations: CatalogRegistrationSnapshot;
  epoch: ReturnType<typeof capturePluginRegistryLifecycleEpoch>;
  gatewaySignal?: AbortSignal;
  pending: Map<string, CatalogListOperation>;
  providers: Map<string, CatalogListOperation>;
  pages: Map<string, CatalogListEnumeration>;
  retirement: AbortController;
};

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListOperations>();
const catalogCallerIds = new WeakMap<GatewayClient, number>();
let nextCatalogCallerId = 0;

export function sessionCatalogListKey(params: {
  agentId: string;
  client: GatewayClient | null;
  request: SessionsCatalogListParams;
  allowPartialResults: boolean;
  search?: string;
  allowProcessHomeFallback: boolean;
  visibilityKey: string;
}): string {
  // Providers inherit this exact caller through Gateway async scope, including node APIs.
  // A matching profile alone cannot make another connection's enumeration reusable.
  let callerId = params.client ? catalogCallerIds.get(params.client) : 0;
  if (params.client && callerId === undefined) {
    callerId = ++nextCatalogCallerId;
    catalogCallerIds.set(params.client, callerId);
  }
  const cursors = params.request.cursors
    ? Object.entries(params.request.cursors).toSorted(([left], [right]) =>
        left.localeCompare(right),
      )
    : null;
  return JSON.stringify([
    params.agentId,
    params.request.catalogId ?? null,
    params.allowPartialResults,
    params.search ?? null,
    params.request.limitPerHost ?? null,
    params.request.hostIds ?? null,
    cursors,
    params.allowProcessHomeFallback,
    params.visibilityKey,
    callerId,
    params.client?.connect?.scopes?.toSorted() ?? [],
    params.client?.connect?.role ?? null,
    params.client?.connect?.device?.id ?? null,
  ]);
}

export function resolvePublishedSessionCatalogs(result: CatalogListEnumeration): SessionCatalog[] {
  return result.publishedHosts
    ? result.catalogs.map((catalog) => {
        const published = result.publishedHosts?.get(catalog.id);
        if (!published?.size || catalog.error) {
          return catalog;
        }
        // The final host set owns withdrawal; pending hosts already occupy their final positions.
        return {
          ...catalog,
          hosts: catalog.hosts.map((host) => published.get(host.hostId) ?? host),
        };
      })
    : result.catalogs;
}

export function getSessionCatalogListOperations(
  config: OpenClawConfig,
  registrations: CatalogRegistrationSnapshot,
  gatewaySignal?: AbortSignal,
): CatalogListOperations {
  let state = catalogListsByConfig.get(config);
  const epoch = registrations.registry
    ? capturePluginRegistryLifecycleEpoch(registrations.registry)
    : undefined;
  if (
    !state ||
    state.registrations !== registrations ||
    state.epoch !== epoch ||
    state.gatewaySignal !== gatewaySignal
  ) {
    state?.retirement.abort();
    state = {
      registrations,
      epoch,
      gatewaySignal,
      pending: new Map(),
      providers: new Map(),
      pages: new Map(),
      retirement: new AbortController(),
    };
    catalogListsByConfig.set(config, state);
  }
  return state;
}

export function retireSessionCatalogLists(config: OpenClawConfig): void {
  const operations = catalogListsByConfig.get(config);
  if (!operations) {
    return;
  }
  // Host publications can outlive the aggregate response and still contain an archived row.
  operations.retirement.abort();
  operations.retirement = new AbortController();
  operations.pending.clear();
  operations.providers.clear();
  operations.pages.clear();
}

export async function listSessionCatalogWithinBudget(
  operations: CatalogListOperations,
  key: string,
  progress: SessionCatalogListLifetime,
  subscribe: (progress: SessionCatalogListLifetime) => void,
  empty: SessionCatalog,
  run: () => Promise<CatalogListEnumeration>,
): Promise<CatalogListEnumeration> {
  const retirement = operations.retirement.signal;
  let active = operations.providers.get(key);
  if (!active) {
    const result = run().then((page) => {
      const catalog = page.catalogs[0]!;
      if (
        !retirement.aborted &&
        !operations.gatewaySignal?.aborted &&
        !catalog.error &&
        catalog.hosts.every((host) => !host.error && !host.pending)
      ) {
        operations.pages.delete(key);
        operations.pages.set(key, page);
        if (operations.pages.size > 128) {
          operations.pages.delete(operations.pages.keys().next().value!);
        }
      }
      return page;
    });
    active = { progress, result };
    operations.providers.set(key, active);
    const entry = active;
    void result
      .finally(() => {
        if (operations.providers.get(key) === entry) {
          operations.providers.delete(key);
        }
      })
      .catch(() => undefined);
  }
  if (active.progress !== progress) {
    subscribe(active.progress);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: CatalogListEnumeration | undefined;
  try {
    result = await Promise.race([
      active.result,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const catalog = result?.catalogs[0];
  const error = catalog?.error ?? catalog?.hosts.find((host) => host.error)?.error;
  if (result && !error) {
    return result;
  }
  const cached =
    retirement.aborted || operations.gatewaySignal?.aborted ? undefined : operations.pages.get(key);
  if (result && !cached) {
    return result;
  }
  const previous = cached?.catalogs[0] ?? empty;
  return {
    catalogs: [
      {
        ...previous,
        hosts: result
          ? previous.hosts
          : previous.hosts.map((host) => Object.assign({}, host, { pending: true })),
        error: {
          code: result ? "catalog_stale" : "catalog_pending",
          message: `${cached ? "Showing stale results. " : ""}${error ? `Refresh failed: [${error.code}] ${error.message}` : "Catalog refresh is still pending; retry shortly."}`,
        },
      },
    ],
    // Preserve the original adoption identity; delivery rechecks current authority.
    instancesByCatalog: cached?.instancesByCatalog ?? new Map([[empty.id, new Map()]]),
  };
}
