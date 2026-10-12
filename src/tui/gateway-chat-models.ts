import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import type { GatewayClient } from "../gateway/client.js";
import type { TuiModelCatalogScope, TuiModelChoice } from "./tui-backend.js";

export type GatewayModelCatalogEntry = {
  scope: TuiModelCatalogScope;
  models?: TuiModelChoice[];
  pending?: Promise<TuiModelChoice[]>;
};

function tuiGatewayModelCatalogKey(scope: TuiModelCatalogScope): string {
  return `${scope.agentId ?? ""}\0${scope.sessionKey ?? ""}`;
}

function sessionScopedCatalog(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(GATEWAY_SERVER_CAPS.SESSION_SCOPED_MODEL_CATALOG) === true;
}

function effectiveCatalogScope(
  scope: TuiModelCatalogScope,
  capabilities: readonly string[] | undefined,
): TuiModelCatalogScope {
  return {
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(sessionScopedCatalog(capabilities) && scope.sessionKey
      ? { sessionKey: scope.sessionKey }
      : {}),
  };
}

export function readTuiGatewayModelCatalog(
  catalogs: ReadonlyMap<string, GatewayModelCatalogEntry>,
  scope: TuiModelCatalogScope,
  capabilities: readonly string[] | undefined,
): TuiModelChoice[] | undefined {
  return catalogs.get(tuiGatewayModelCatalogKey(effectiveCatalogScope(scope, capabilities)))
    ?.models;
}

export function refreshTuiGatewayModelCatalog(params: {
  catalogs: Map<string, GatewayModelCatalogEntry>;
  client: Pick<GatewayClient, "request">;
  agentId?: string;
  sessionKey?: string;
  capabilities?: readonly string[];
  published: boolean;
  onChanged?: (scope: TuiModelCatalogScope) => void;
}): Promise<TuiModelChoice[]> {
  const { catalogs, client, agentId, published, onChanged } = params;
  const scope = effectiveCatalogScope(params, params.capabilities);
  const key = tuiGatewayModelCatalogKey(scope);
  let entry = catalogs.get(key);
  if (!entry) {
    entry = { scope };
    catalogs.set(key, entry);
  }
  if (entry.pending) {
    return entry.pending;
  }
  const owner = entry;
  const current = () => catalogs.get(key) === owner && owner.pending === pending;
  const pending = client
    .request("models.list", {
      ...(agentId ? { agentId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
      ...(published ? { includeDetails: true } : {}),
    })
    .then((res) => {
      if (!current()) {
        return catalogs.get(key)?.models ?? [];
      }
      const models: TuiModelChoice[] = Array.isArray(res?.models) ? res.models : [];
      // Released Gateways reject includeDetails and collapse unknown availability to false.
      owner.models = published
        ? models
        : models.map(({ available: _available, unavailableReason: _reason, ...model }) => model);
      onChanged?.(scope);
      return owner.models;
    })
    .catch((error: unknown) => {
      if (!current()) {
        return catalogs.get(key)?.models ?? [];
      }
      throw error;
    })
    .finally(() => {
      if (current()) {
        owner.pending = undefined;
      }
    });
  owner.pending = pending;
  return pending;
}
