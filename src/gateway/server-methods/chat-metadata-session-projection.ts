import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatMetadataProjectionFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
  modelCatalog: ModelCatalogSnapshot;
};

export type PreparedAgentProjection<T = ChatMetadataResult> = {
  modelCatalog: ModelCatalogEntry[];
  read: () => T;
  isCurrent: () => boolean;
};

export async function prepareChatMetadataModelProjection(params: {
  context: GatewayRequestContext;
  facts: ChatMetadataProjectionFacts;
  requesterProfileId?: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  assertCurrent?: () => void;
}): Promise<PreparedAgentProjection<{ models?: ModelChoice[] }>> {
  const { prepareModelsListResult, createGatewayAgentModelCatalogProjector } =
    await import("./models-list-result.js");
  // A draft has no persisted session grant: recheck its live human before hydrating private auth.
  params.assertCurrent?.();
  // Chat metadata must stay on process-published facts. Live discovery belongs to explicit
  // models.list control-plane reads so a slow provider cannot delay chat startup.
  const snapshot = params.facts.modelCatalog;
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: params.facts.owner.config,
    agentId: params.facts.agentId,
    snapshot,
    metadataSnapshot: params.facts.owner.metadataSnapshot,
    preparedAuthStore: params.facts.authStore,
    requesterProfileId: params.requesterProfileId,
    // The owner records usable auth at discovery; metadata must share that exact generation fact.
    preparedRuntimeAuthModes: params.facts.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(
      params.facts.owner,
    ),
    pluginRegistry: params.facts.owner.pluginRegistry,
    isCurrent: params.facts.owner.isCurrent,
    observationConfig: params.facts.owner.observationConfig,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.pinnedProfileId ? { pinnedProfileId: params.pinnedProfileId } : {}),
  });
  const [modelCatalog, readModels] = await Promise.all([
    projector.projectCatalog(),
    prepareModelsListResult({
      source: { kind: "gateway", context: params.context },
      agentId: params.facts.agentId,
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: params.facts.agentId,
        config: params.facts.owner.config,
        snapshot,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  return {
    modelCatalog,
    read: () => ({ models: readModels.read().models }),
    isCurrent: readModels.isCurrent,
  };
}

export function resolveSessionCatalogProfiles(sessionEntry: ChatMetadataSessionEntry | undefined): {
  preferredProfileId?: string;
  pinnedProfileId?: string;
} {
  const profileId = sessionEntry?.authProfileOverride?.trim();
  if (!profileId) {
    return {};
  }
  const profileSource = resolveCollapsedSessionAuthPinSource(sessionEntry);
  return {
    preferredProfileId: profileId,
    ...(profileSource === "user" ? { pinnedProfileId: profileId } : {}),
  };
}

// Read native ownership after profile projection; never cache this session overlay.
export function projectSessionModelCatalog(
  readParams: ChatMetadataReadParams,
  models: ModelChoice[],
  config: OpenClawConfig,
): ModelChoice[] {
  const ownership = readSessionRuntimeOwnership({ ...readParams, config });
  if (ownership?.auth !== "native") {
    return models;
  }
  // Pending native branches have no tuple. Omit host readiness without claiming native login.
  const renderedModel =
    ownership.modelRef ??
    resolveSessionModelRef(config, readParams.sessionEntry, readParams.agentId, {
      allowPluginNormalization: false,
    });
  return models.map((model) => {
    if (model.provider !== renderedModel.provider || model.id !== renderedModel.model) {
      return model;
    }
    const {
      available: _available,
      unavailableReason: _reason,
      unavailableUntil: _until,
      ...native
    } = model;
    return native;
  });
}

export function projectChatSessionMetadata(
  readParams: ChatMetadataReadParams,
  metadata: ChatMetadataResult,
  config: OpenClawConfig,
): ChatMetadataResult {
  return metadata.models
    ? { ...metadata, models: projectSessionModelCatalog(readParams, metadata.models, config) }
    : metadata;
}
