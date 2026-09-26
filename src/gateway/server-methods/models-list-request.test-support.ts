import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { PreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

export function requestModelsList(params: {
  view: "default" | "configured" | "provider-config" | "all";
  agentId?: string;
  runtimeConfig?: OpenClawConfig;
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
  includeDefaultModels?: boolean;
  includeProviderCapabilities?: boolean;
  deferredAuth?: Promise<PreparedModelRuntimeAuth>;
  refresh?: boolean;
  publishedCatalog?: ModelCatalogEntry[];
  catalogComplete?: boolean;
  preparedAuthModes?: PreparedModelRuntimeAuth["authModes"];
}) {
  const respond = vi.fn();
  const runtimeConfig = params.runtimeConfig ?? {};
  const getRuntimeConfig = () => runtimeConfig;
  const resolveOwnerFacts = () => {
    const config = getRuntimeConfig();
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    return {
      agentId,
      agentDir,
      workspaceDir: agentDir,
      config,
      observationConfig: config,
      isCurrent: () => getRuntimeConfig() === config,
      authModes: params.preparedAuthModes ?? {},
      authStore:
        getPreparedRuntimeAuthProfileStoreSnapshot(agentDir) ??
        loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
    };
  };
  const loadGatewayModelCatalogSnapshot = async (
    loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0],
  ): Promise<PreparedGatewayModelCatalogSnapshot> => {
    const entries = await params.loadGatewayModelCatalog(loadParams);
    const owner = resolveOwnerFacts();
    // The public-projection tests deliberately inject malformed catalog fields.
    return {
      ...owner,
      ...(loadParams?.agentId ? { agentId: loadParams.agentId } : {}),
      catalogComplete: params.catalogComplete ?? loadParams?.readOnly === false,
      entries,
      routeVariants: entries,
      authMaterializations: [],
    } as unknown as PreparedGatewayModelCatalogSnapshot;
  };
  let published: PreparedGatewayModelCatalogSnapshot | undefined;
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: async (loadParams) => {
      const snapshot = await loadGatewayModelCatalogSnapshot(loadParams);
      published = snapshot;
      if (!params.deferredAuth) {
        return snapshot;
      }
      published = { ...snapshot, ...(await params.deferredAuth) };
      return published;
    },
    readPrepared: async () => {
      if (published && published.config === getRuntimeConfig()) {
        return published;
      }
      published = params.publishedCatalog
        ? {
            ...resolveOwnerFacts(),
            catalogComplete: false,
            entries: params.publishedCatalog,
            routeVariants: params.publishedCatalog,
            authMaterializations: [],
          }
        : await loadGatewayModelCatalogSnapshot({ agentId: params.agentId, readOnly: true });
      return published;
    },
  });
  const requestParams = {
    view: params.view,
    ...(params.includeDefaultModels === undefined
      ? {}
      : { includeDefaultModels: params.includeDefaultModels }),
    ...(params.refresh ? { refresh: true } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
  };
  const request = expectDefined(
    modelsHandlers["models.list"],
    'modelsHandlers["models.list"] test invariant',
  )({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: requestParams,
    },
    params: requestParams,
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      logGateway: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}
