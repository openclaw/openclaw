import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";

export type CatalogListEnumeration = {
  catalogs: SessionCatalog[];
  instances: SessionCatalogInstances;
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
