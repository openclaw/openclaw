import type {
  SessionCatalog,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { capturePluginRegistryLifecycleEpoch } from "../../plugins/registry-lifecycle.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import {
  SESSION_CATALOG_LIST_LIFETIME_MS,
  type SessionCatalogListLifetime,
} from "./session-catalog-list-lifetime.js";
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
  connectionSignal?: AbortSignal;
  pending: Map<string, CatalogListOperation>;
  providers: Map<string, CatalogListOperation & { release: () => void }>;
  pages: Map<string, CatalogListEnumeration>;
  retirement: AbortController;
};

type CatalogListGeneration = CatalogListOperations & {
  callers: WeakMap<GatewayClient, CatalogListOperations>;
};

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListGeneration>();

export function sessionCatalogListKey(params: {
  agentId: string;
  client: GatewayClient | null;
  request: SessionsCatalogListParams;
  allowPartialResults: boolean;
  search?: string;
  allowProcessHomeFallback: boolean;
  visibilityKey: string;
}): string {
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
  client?: GatewayClient | null,
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
      callers: new WeakMap(),
    };
    catalogListsByConfig.set(config, state);
  }
  if (!client) {
    return state;
  }
  // Providers inherit the exact caller through async scope, including node APIs.
  // Keep that security boundary without retaining reconnect IDs in a global map.
  let caller = state.callers.get(client);
  if (!caller) {
    caller = {
      registrations,
      epoch,
      gatewaySignal,
      connectionSignal: client.connectionSignal
        ? AbortSignal.any([state.retirement.signal, client.connectionSignal])
        : undefined,
      retirement: state.retirement,
      pending: new Map(),
      providers: new Map(),
      pages: new Map(),
    };
    state.callers.set(client, caller);
    const owned = caller;
    const close = () => {
      owned.pending.clear();
      for (const entry of owned.providers.values()) {
        entry.release();
      }
      owned.pages.clear();
    };
    owned.connectionSignal?.addEventListener("abort", close, { once: true });
    if (owned.connectionSignal?.aborted) {
      close();
    }
  }
  return caller;
}

export function retireSessionCatalogLists(config: OpenClawConfig): void {
  const operations = catalogListsByConfig.get(config);
  if (!operations) {
    return;
  }
  // Host publications can outlive the aggregate response and still contain an archived row.
  operations.retirement.abort();
  catalogListsByConfig.delete(config);
  operations.pending.clear();
  operations.providers.clear();
  operations.pages.clear();
}

// Pending source promises may outlive delivery. Their reactions retain only
// this detachable owner, never the aggregate frame or an evicted progress owner.
function startProviderOperation(
  operations: CatalogListOperations,
  key: string,
  progress: SessionCatalogListLifetime,
  run: () => Promise<CatalogListEnumeration>,
): CatalogListOperation & { release: () => void } {
  let owner: { operations: CatalogListOperations; key: string; signal: AbortSignal } | undefined = {
    operations,
    key,
    signal: AbortSignal.any([
      operations.retirement.signal,
      ...(operations.gatewaySignal ? [operations.gatewaySignal] : []),
      ...(operations.connectionSignal ? [operations.connectionSignal] : []),
    ]),
  };
  const result = run().then((page) => {
    const current = owner;
    const catalog = page.catalogs[0]!;
    if (
      current &&
      !current.signal.aborted &&
      current.operations.providers.get(current.key)?.result === result &&
      !catalog.error &&
      catalog.hosts.every((host) => !host.error && !host.pending)
    ) {
      const pages = current.operations.pages;
      pages.delete(current.key);
      pages.set(current.key, page);
      if (pages.size > 128) {
        pages.delete(pages.keys().next().value!);
      }
    }
    return page;
  });
  const release = () => {
    clearTimeout(deadline);
    const current = owner;
    owner = undefined;
    current?.signal.removeEventListener("abort", release);
    if (current?.operations.providers.get(current.key)?.result === result) {
      current.operations.providers.delete(current.key);
    }
  };
  const deadline = setTimeout(release, SESSION_CATALOG_LIST_LIFETIME_MS);
  deadline.unref();
  const entry = { progress, result, release };
  operations.providers.set(key, entry);
  owner.signal.addEventListener("abort", release, { once: true });
  if (owner.signal.aborted) {
    release();
  }
  void result.then(release, release);
  return entry;
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
    active = startProviderOperation(operations, key, progress, run);
    if (operations.providers.size > 128) {
      operations.providers.values().next().value!.release();
    }
  }
  if (active.progress !== progress) {
    subscribe(active.progress);
  }
  const result = await raceWithTimeout(active.result, 1_000, () => undefined, { ref: false });
  const catalog = result?.catalogs[0];
  const error = catalog?.error ?? catalog?.hosts.find((host) => host.error)?.error;
  if (result && !error) {
    return result;
  }
  const cached =
    retirement.aborted || operations.gatewaySignal?.aborted || operations.connectionSignal?.aborted
      ? undefined
      : operations.pages.get(key);
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
