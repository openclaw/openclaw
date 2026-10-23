import type {
  SessionsCatalogArchiveParams,
  SessionsCatalogImportParams,
  SessionsCatalogImportResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { readSessionMethodScopeAccess } from "../lib/session-method-access.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { excludeSessionCatalogRows } from "./app-sidebar-session-catalog-state.ts";
import type {
  SidebarSessionMutationScope,
  SidebarCatalogSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

export async function archiveSessionCatalog(
  owner: SessionCatalogDataOwner & {
    pendingCatalogArchives: ReadonlySet<string>;
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    invalidateSessionCatalogs(): void;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogArchiveParams,
): Promise<void> {
  const generation = scope.catalogGeneration;
  const key = buildCatalogSessionKey(params);
  owner.pendingCatalogArchives = new Set([...owner.pendingCatalogArchives, key]);
  owner.requestSessionDataUpdate();
  try {
    await scope.client.request("sessions.catalog.archive", params);
    if (generation === owner.sessionScopeGeneration && owner.isSessionMutationScopeCurrent(scope)) {
      owner.sessionCatalogs = excludeSessionCatalogRows(owner.sessionCatalogs, new Set([key]));
      owner.invalidateSessionCatalogs();
    }
  } finally {
    if (generation === owner.sessionScopeGeneration) {
      owner.pendingCatalogArchives = new Set(
        [...owner.pendingCatalogArchives].filter((entry) => entry !== key),
      );
      owner.requestSessionDataUpdate();
    }
  }
}

export async function importSessionCatalog(
  owner: SessionCatalogDataOwner & {
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    refreshSidebarSessions(agentId?: string): Promise<void>;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogImportParams,
): Promise<SessionsCatalogImportResult | null> {
  const isCurrent = () =>
    scope.catalogGeneration === owner.sessionScopeGeneration &&
    owner.isSessionMutationScopeCurrent(scope);
  if (!isCurrent()) {
    return null;
  }
  const access = readSessionMethodScopeAccess(scope.gateway.snapshot.hello?.auth, {
    method: "sessions.catalog.import",
    requiredScope: "operator.write",
  });
  if (!access.allowed) {
    throw new Error(access.reason);
  }
  const result = await scope.client.request<SessionsCatalogImportResult>(
    "sessions.catalog.import",
    params,
  );
  if (!isCurrent()) {
    return null;
  }
  void owner.refreshSidebarSessions(params.agentId);
  return result;
}
