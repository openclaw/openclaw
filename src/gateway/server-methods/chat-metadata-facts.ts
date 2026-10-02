import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  withPreparedModelRuntimeReadBatch,
  type GetPublishedPreparedModelCatalogOwnerParams,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import type {
  ChatMetadataProjectionFacts,
  prepareChatMetadataModelProjection,
} from "./chat-metadata-session-projection.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";

export type PreparedAgentFacts = ChatMetadataProjectionFacts & {
  authStoreRevision: string;
  catalogRefreshFailed: boolean;
  skillsVersion: number;
};

export type PreparedGenerationFacts = {
  config: OpenClawConfig;
  configKey: string;
  pluginRegistryVersion: number;
  agents: PreparedAgentFacts[];
};

export type ChatMetadataRuntimeDeps = {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayModelCatalogContext;
  getPreparedOwner: (
    params: GetPublishedPreparedModelCatalogOwnerParams,
  ) => PreparedModelRuntimeSnapshot | undefined;
  getPreparedAuthStore: (
    agentDir?: string,
    inheritedAuthDir?: string,
  ) => AuthProfileStore | undefined;
  getAuthStoreRevision: (agentDir?: string) => number;
  getSkillsVersion: (workspaceDir?: string) => number;
  getPluginRegistryVersion: () => number;
  buildCommands: (params: {
    cfg: OpenClawConfig;
    agentId: string;
  }) => Promise<{ commands?: unknown[] }>;
  buildProjection: typeof prepareChatMetadataModelProjection;
};

export class ChatMetadataSnapshotUnavailableError extends Error {
  constructor(message = "prepared chat metadata snapshot is unavailable") {
    super(message);
    this.name = "ChatMetadataSnapshotUnavailableError";
  }
}

export function captureGenerationFacts(deps: ChatMetadataRuntimeDeps): PreparedGenerationFacts {
  const config = deps.getConfig();
  const agents = withPreparedModelRuntimeReadBatch(() =>
    withAgentRosterFactsBatch(config, () =>
      listAgentIds(config)
        .filter((agentId) => !readAgentDatabaseAdmissionRefusal(agentId))
        .flatMap((rawAgentId): PreparedAgentFacts[] => {
          const agentId = normalizeAgentId(rawAgentId);
          // Metadata follows the published lifecycle owner while its replacement gate owns turnover;
          // display-only config publications must not make that still-current owner disappear.
          const owner = deps.getPreparedOwner({ agentId, config });
          if (!owner) {
            if (getPreparedModelRuntimeStartupStatus()?.degraded) {
              return [];
            }
            throw new ChatMetadataSnapshotUnavailableError(
              `prepared chat metadata owner is unavailable for agent "${agentId}"`,
            );
          }
          const workspaceDir = owner.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
          const fullModelCatalog = owner.readFullModelCatalog?.();
          const fullCatalogAuth = fullModelCatalog
            ? getPreparedModelFullCatalogAuth(fullModelCatalog)
            : undefined;
          if (fullModelCatalog && !fullCatalogAuth) {
            throw new Error("prepared full model catalog omitted its auth generation");
          }
          const catalog = fullModelCatalog ?? owner.modelCatalog;
          return [
            {
              agentId,
              owner,
              authStore: fullCatalogAuth?.authStore ??
                deps.getPreparedAuthStore(owner.agentDir, owner.inheritedAuthDir) ?? {
                  version: 1,
                  profiles: {},
                },
              authModes: fullCatalogAuth?.authModes ?? owner.authModes,
              authStoreRevision: `${deps.getAuthStoreRevision(owner.agentDir)}:${deps.getAuthStoreRevision(owner.inheritedAuthDir)}`,
              modelCatalog: catalog,
              // Failure is visible metadata; in-flight discovery does not invalidate usable rows.
              catalogRefreshFailed: catalog.refreshFailed === true,
              skillsVersion: deps.getSkillsVersion(workspaceDir),
            },
          ];
        }),
    ),
  );
  return {
    config,
    configKey: resolveRuntimeConfigCacheKey(config),
    pluginRegistryVersion: deps.getPluginRegistryVersion(),
    agents,
  };
}

export function generationFactsMatch(
  left: PreparedGenerationFacts,
  right: PreparedGenerationFacts,
  scope: "metadata" | "catalog" | "auth" = "metadata",
): boolean {
  if (
    left.configKey !== right.configKey ||
    left.pluginRegistryVersion !== right.pluginRegistryVersion ||
    left.agents.length !== right.agents.length
  ) {
    return false;
  }
  return left.agents.every((agent, index) => {
    const candidate = right.agents[index];
    return (
      candidate?.agentId === agent.agentId &&
      candidate.owner === agent.owner &&
      candidate.authStoreRevision === agent.authStoreRevision &&
      // Full catalogs carry their own paired auth generation.
      candidate.modelCatalog === agent.modelCatalog &&
      (scope === "auth" || candidate.catalogRefreshFailed === agent.catalogRefreshFailed) &&
      (scope !== "metadata" || candidate.skillsVersion === agent.skillsVersion)
    );
  });
}
