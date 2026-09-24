import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { GetPublishedPreparedModelCatalogOwnerParams } from "../../agents/prepared-model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import type {
  ChatMetadataProjectionFacts,
  prepareChatMetadataModelProjection,
} from "./chat-metadata-session-projection.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";

export type PreparedAgentFacts = ChatMetadataProjectionFacts & {
  authStoreRevision: string;
  catalogRefreshFailed: boolean;
  skillsVersion: number;
  swarmEnabled: boolean;
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
    sessionKey?: string;
    sessionEntry?: ChatMetadataReadParams["sessionEntry"];
  }) => Promise<{ commands?: unknown[] }>;
  buildProjection: typeof prepareChatMetadataModelProjection;
};

export function generationFactsMatch(
  left: PreparedGenerationFacts,
  right: PreparedGenerationFacts,
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
      candidate.modelCatalog === agent.modelCatalog &&
      candidate.catalogRefreshFailed === agent.catalogRefreshFailed &&
      candidate.skillsVersion === agent.skillsVersion
    );
  });
}
