import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "../agents/prepared-model-catalog.types.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  loadPreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "../agents/prepared-model-runtime.full-catalog.js";
// Gateway catalog reads use the atomic prepared runtime generation.
import { getRuntimeConfig } from "../config/io.js";
import type { PreparedGatewayModelCatalogSnapshot } from "./server-model-catalog-auth.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import type {
  GatewayModelCatalogLoadParams,
  GatewayModelCatalogSnapshot,
  PreparedGatewayModelCatalog,
  PreparedGatewayModelCatalogReadResult,
} from "./server-model-catalog.types.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
export type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadPublishedPreparedModelCatalogOwnerSnapshot = (params: {
  agentId?: string;
  agentDir?: string;
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
  refreshFullCatalog?: LoadPreparedModelCatalogParams["refreshFullCatalog"];
  providerDiscoveryProviderIds?: readonly string[];
  workspaceDir?: string;
}) => Promise<PublishedModelCatalogOwnerCandidate>;
type LoadPreparedModelCatalogSnapshot = (
  params: LoadPreparedModelCatalogParams,
) => Promise<ModelCatalogSnapshot>;
type LoadGatewayModelCatalogParams = GatewayModelCatalogLoadParams & {
  getConfig?: () => GatewayModelCatalogConfig;
  loadPublishedPreparedModelCatalogOwnerSnapshot?: LoadPublishedPreparedModelCatalogOwnerSnapshot;
  loadPreparedModelCatalogSnapshot?: LoadPreparedModelCatalogSnapshot;
  refreshFullCatalog?: LoadPreparedModelCatalogParams["refreshFullCatalog"];
};
type LoadPreparedGatewayModelCatalogParams = LoadGatewayModelCatalogParams & {
  authScope?: PreparedModelRuntimeAuthScope;
  refreshAuth?: boolean;
};

async function loadGatewayModelCatalogOwnerSnapshot(
  params?: LoadPreparedGatewayModelCatalogParams,
): Promise<{
  candidate: PublishedModelCatalogOwnerCandidate;
  owner: ResolvedPublishedModelCatalogOwner & {
    authMaterializations: PreparedGatewayModelCatalogSnapshot["authMaterializations"];
  };
}> {
  const loadOwner = await (params?.loadPublishedPreparedModelCatalogOwnerSnapshot ??
    import("../agents/prepared-model-catalog.js").then(
      (module) => module.loadPublishedPreparedModelCatalogOwnerSnapshot,
    ));
  const candidate = await loadOwner({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config: (params?.getConfig ?? getRuntimeConfig)(),
    readOnly: params?.readOnly !== false,
    ...(params?.refreshFullCatalog !== undefined
      ? { refreshFullCatalog: params.refreshFullCatalog }
      : {}),
    ...(params?.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds }
      : {}),
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const owner = resolvePublishedModelCatalogOwner(candidate);
  return {
    candidate,
    owner: {
      ...owner,
      authMaterializations: getPreparedModelRuntimeAuthMaterializations(candidate),
    },
  };
}

function projectGatewayModelCatalogSnapshot(
  owner: Pick<
    ResolvedPublishedModelCatalogOwner,
    "agentId" | "agentDir" | "workspaceDir" | "config" | "modelCatalog"
  >,
): GatewayModelCatalogSnapshot {
  return {
    ...owner.modelCatalog,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    catalogComplete: isPreparedModelCatalogFull(owner.modelCatalog),
    workspaceDir: owner.workspaceDir,
    config: owner.config,
  };
}

export async function loadPreparedGatewayModelCatalogSnapshot(
  params?: LoadPreparedGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalogSnapshot> {
  for (;;) {
    let loaded: Awaited<ReturnType<typeof loadGatewayModelCatalogOwnerSnapshot>>;
    let refreshedAuth: Awaited<ReturnType<typeof loadPreparedModelRuntimeAuth>>;
    try {
      loaded = await loadGatewayModelCatalogOwnerSnapshot(params);
      refreshedAuth = params?.refreshAuth
        ? await loadPreparedModelRuntimeAuth(
            loaded.candidate,
            params.authScope ?? {
              providerIds: loaded.owner.modelCatalog.entries.map((entry) => entry.provider),
            },
          )
        : undefined;
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        // Supersession invalidates every captured owner fact. Reacquire the whole owner so
        // replacement auth cannot be combined with stale catalog or metadata.
        continue;
      }
      throw error;
    }
    const { owner } = loaded;
    let modelCatalog = owner.modelCatalog;
    const providerIds = params?.providerDiscoveryProviderIds;
    if (providerIds?.length) {
      if (!owner.isCurrent()) {
        continue;
      }
      const loadScoped =
        params?.loadPreparedModelCatalogSnapshot ??
        (await import("../agents/prepared-model-catalog.js")).loadPreparedModelCatalogSnapshot;
      modelCatalog = await loadScoped({
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        config: owner.config,
        providerDiscoveryProviderIds: providerIds,
        readOnly: true,
        ...(params?.scopedLiveProviderDiscovery ? { scopedLiveProviderDiscovery: true } : {}),
        workspaceDir: owner.workspaceDir,
      });
      if (!owner.isCurrent()) {
        continue;
      }
    }
    return {
      ...projectGatewayModelCatalogSnapshot({ ...owner, modelCatalog }),
      authModes: refreshedAuth?.authModes ?? owner.authModes,
      authStore: refreshedAuth?.authStore ?? owner.authStore,
      metadataSnapshot: owner.metadataSnapshot,
      authMaterializations: owner.authMaterializations,
      pluginRegistry: owner.pluginRegistry,
      isCurrent: owner.isCurrent,
      observationConfig: owner.observationConfig,
      accountCatalog: owner.accountCatalog,
    };
  }
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  const {
    authModes: _authModes,
    authStore: _authStore,
    metadataSnapshot: _metadataSnapshot,
    authMaterializations: _authMaterializations,
    pluginRegistry: _pluginRegistry,
    isCurrent: _isCurrent,
    observationConfig: _observationConfig,
    accountCatalog: _accountCatalog,
    ...snapshot
  } = await loadPreparedGatewayModelCatalogSnapshot(params);
  return snapshot;
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}

function readPreparedGatewayModelCatalogSync(
  getPreparedModelCatalogOwnerSnapshot: typeof import("../agents/prepared-model-catalog.js").getPreparedModelCatalogOwnerSnapshot,
  config: GatewayModelCatalogConfig,
  params?: LoadGatewayModelCatalogParams,
): PreparedGatewayModelCatalog | undefined {
  const owner = getPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    readOnly: true,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!owner) {
    return undefined;
  }
  const catalog = owner.readFullModelCatalog?.() ?? owner.modelCatalog;
  return createPreparedGatewayModelCatalog({
    entries: catalog.entries,
    routeVariants: catalog.routeVariants,
    pluginRegistry: owner.pluginRegistry,
    metadataSnapshot: owner.metadataSnapshot,
  });
}

/** Reads the newest completed published catalog without starting provider discovery. */
export async function readPreparedGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalog | undefined> {
  const { getPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  return readPreparedGatewayModelCatalogSync(
    getPreparedModelCatalogOwnerSnapshot,
    (params?.getConfig ?? getRuntimeConfig)(),
    params,
  );
}

export async function readPreparedGatewayModelCatalogBatch(
  agentIds: readonly string[],
  params?: Pick<LoadGatewayModelCatalogParams, "getConfig">,
): Promise<PreparedGatewayModelCatalogReadResult[]> {
  if (agentIds.length === 0) {
    return [];
  }
  const { getPreparedModelCatalogOwnerSnapshot, withPreparedModelRuntimeReadBatch } =
    await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  // Both read scopes end before yielding, so publication cannot leave stale candidates behind.
  return withPreparedModelRuntimeReadBatch(() =>
    withAgentRosterFactsBatch(config, () =>
      agentIds.map((agentId): PreparedGatewayModelCatalogReadResult => {
        try {
          return {
            status: "fulfilled",
            value: readPreparedGatewayModelCatalogSync(
              getPreparedModelCatalogOwnerSnapshot,
              config,
              {
                agentId,
              },
            ),
          };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      }),
    ),
  );
}

/** Reads the published owner generation without activating full catalog discovery. */
export async function readPreparedGatewayModelCatalogOwnerSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalogSnapshot | undefined> {
  const {
    getPublishedPreparedModelCatalogOwnerSnapshot,
    getPendingPreparedModelRuntimeReplacement,
    materializePreparedModelCatalogOwner,
  } = await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const replacement = getPendingPreparedModelRuntimeReplacement();
  if (replacement) {
    await replacement;
    return readPreparedGatewayModelCatalogOwnerSnapshot(params);
  }
  const candidate = getPublishedPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!candidate) {
    return undefined;
  }
  const published = materializePreparedModelCatalogOwner(candidate);
  const owner = resolvePublishedModelCatalogOwner(published);
  return {
    ...projectGatewayModelCatalogSnapshot(owner),
    authModes: owner.authModes,
    authStore: owner.authStore,
    metadataSnapshot: owner.metadataSnapshot,
    authMaterializations: getPreparedModelRuntimeAuthMaterializations(published),
    pluginRegistry: owner.pluginRegistry,
    isCurrent: owner.isCurrent,
    observationConfig: owner.observationConfig,
    accountCatalog: owner.accountCatalog,
  };
}
