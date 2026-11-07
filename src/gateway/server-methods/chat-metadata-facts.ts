import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles.js";
import {
  getRuntimeAuthProfileStoreCatalogRevision,
  getRuntimeAuthProfileStoreMetadataRevision,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  withPreparedModelRuntimeReadBatch,
  getPublishedPreparedModelCatalogOwnerSnapshot,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { resolveRuntimeModelConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import { readAgentDatabaseReadAdmissionRefusal } from "../../state/agent-database-admission.js";
import type { ChatMetadataProjectionFacts } from "./chat-metadata-session-projection.js";

type PreparedAgentFacts = ChatMetadataProjectionFacts & {
  authStoreRevision: string;
  authCatalogRevision: string;
  catalogRefreshFailed: boolean;
  skillsVersion: number;
};

export type PreparedGenerationFacts = {
  config: OpenClawConfig;
  configKey: string;
  pluginRegistryVersion: number;
  agents: PreparedAgentFacts[];
};

export class ChatMetadataSnapshotUnavailableError extends Error {
  constructor(message = "prepared chat metadata snapshot is unavailable") {
    super(message);
    this.name = "ChatMetadataSnapshotUnavailableError";
  }
}

// Only publication can replace a retired owner's facts; retrying the same generation cannot.
export function assertPreparedAgentCurrent(agent: ChatMetadataProjectionFacts) {
  if (!agent.owner.isCurrent()) {
    throw new ChatMetadataSnapshotUnavailableError(
      `prepared chat metadata owner retired for agent "${agent.agentId}"`,
    );
  }
}

export function authStoresCurrent(facts: PreparedGenerationFacts) {
  // Shared ownership cannot change within this synchronous scan; resolve it again next read.
  let sharedRevision: number | undefined;
  return facts.agents.every(
    ({ owner, authStoreRevision }) =>
      authStoreRevision ===
      `${getRuntimeAuthProfileStoreMetadataRevision(owner.agentDir)}:${
        owner.inheritedAuthDir
          ? getRuntimeAuthProfileStoreMetadataRevision(owner.inheritedAuthDir)
          : (sharedRevision ??= getRuntimeAuthProfileStoreMetadataRevision())
      }`,
  );
}

export function captureGenerationFacts(config: OpenClawConfig): PreparedGenerationFacts {
  const agents = withPreparedModelRuntimeReadBatch(() =>
    withAgentRosterFactsBatch(config, () =>
      listAgentIds(config)
        .filter((agentId) => !readAgentDatabaseReadAdmissionRefusal(agentId))
        .flatMap((rawAgentId): PreparedAgentFacts[] => {
          const agentId = normalizeAgentId(rawAgentId);
          // Metadata follows the published lifecycle owner while its replacement gate owns turnover;
          // display-only config publications must not make that still-current owner disappear.
          const owner = getPublishedPreparedModelCatalogOwnerSnapshot({ agentId, config });
          if (!owner) {
            // An absent agent must not withdraw metadata for the published, healthy fleet.
            return [];
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
                getPreparedRuntimeAuthProfileStoreSnapshot(
                  owner.agentDir,
                  owner.inheritedAuthDir,
                ) ?? {
                  version: 1,
                  profiles: {},
                },
              authModes: fullCatalogAuth?.authModes ?? owner.authModes,
              authStoreRevision: `${getRuntimeAuthProfileStoreMetadataRevision(owner.agentDir)}:${getRuntimeAuthProfileStoreMetadataRevision(owner.inheritedAuthDir)}`,
              authCatalogRevision: `${getRuntimeAuthProfileStoreCatalogRevision(owner.agentDir)}:${getRuntimeAuthProfileStoreCatalogRevision(owner.inheritedAuthDir)}`,
              modelCatalog: catalog,
              // Failure is visible metadata; in-flight discovery does not invalidate usable rows.
              catalogRefreshFailed: catalog.refreshFailed === true,
              skillsVersion: getSkillsSnapshotVersion(workspaceDir),
            },
          ];
        }),
    ),
  );
  return {
    config,
    configKey: resolveRuntimeModelConfigCacheKey(config),
    pluginRegistryVersion: getActivePluginRegistryVersion(),
    agents,
  };
}

type FactsScope = "metadata" | "catalog" | "catalog-notification" | "auth" | "commands";

export function agentFactsMatch(
  left: PreparedAgentFacts | undefined,
  right: PreparedAgentFacts | undefined,
  scope: FactsScope,
): boolean {
  return Boolean(
    left &&
    right &&
    left.agentId === right.agentId &&
    (scope === "commands"
      ? left.skillsVersion === right.skillsVersion &&
        left.owner.workspaceDir === right.owner.workspaceDir
      : // Config stamping replaces the reader object without replacing its generation.
        left.owner.isCurrent === right.owner.isCurrent &&
        (scope === "catalog-notification"
          ? left.authCatalogRevision === right.authCatalogRevision
          : left.authStoreRevision === right.authStoreRevision) &&
        // Full catalogs carry their own paired auth generation.
        left.modelCatalog === right.modelCatalog &&
        (scope === "auth" || left.catalogRefreshFailed === right.catalogRefreshFailed) &&
        (scope !== "metadata" || left.skillsVersion === right.skillsVersion)),
  );
}

export function generationFactsMatch(
  left: PreparedGenerationFacts,
  right: PreparedGenerationFacts,
  scope: FactsScope = "metadata",
): boolean {
  if (
    left.configKey !== right.configKey ||
    left.pluginRegistryVersion !== right.pluginRegistryVersion ||
    left.agents.length !== right.agents.length
  ) {
    return false;
  }
  return left.agents.every((agent, index) => agentFactsMatch(agent, right.agents[index], scope));
}
