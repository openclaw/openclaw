import type {
  SessionCatalog,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayClient } from "./types.js";

export type CatalogListEnumeration = {
  catalogs: SessionCatalog[];
  instances: SessionCatalogInstances;
  publishedHosts?: Map<string, Map<string, SessionCatalog["hosts"][number]>>;
};

type CatalogListOperation = {
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListOperations = {
  registrations: CatalogRegistrationSnapshot;
  pending: Map<string, CatalogListOperation>;
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
): CatalogListOperations {
  let state = catalogListsByConfig.get(config);
  if (!state || state.registrations !== registrations) {
    state?.retirement.abort();
    state = { registrations, pending: new Map(), retirement: new AbortController() };
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
}
