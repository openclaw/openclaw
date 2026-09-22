import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";

export type CatalogListEnumeration = {
  catalogs: SessionCatalog[];
  instances: SessionCatalogInstances;
};

type CatalogListCacheEntry = {
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListCacheState = {
  registrations: CatalogRegistrationSnapshot;
  pending: Map<string, CatalogListCacheEntry>;
  entries: Map<string, CatalogListCacheEntry & { expiresAt: number }>;
};

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListCacheState>();

export function getSessionCatalogListCache(
  config: OpenClawConfig,
  registrations: CatalogRegistrationSnapshot,
): CatalogListCacheState {
  let state = catalogListsByConfig.get(config);
  if (!state || state.registrations !== registrations) {
    state = { registrations, pending: new Map(), entries: new Map() };
    catalogListsByConfig.set(config, state);
  }
  return state;
}

export function retireSessionCatalogLists(config: OpenClawConfig): void {
  const cache = catalogListsByConfig.get(config);
  if (!cache) {
    return;
  }
  // Host publications can outlive the aggregate response and still contain an archived row.
  for (const entries of [cache.pending, cache.entries]) {
    for (const entry of entries.values()) {
      entry.progress.retire();
    }
    entries.clear();
  }
}
