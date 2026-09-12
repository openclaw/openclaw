import type {
  ModelChoice,
  ModelAllowList,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "../../agents/model-ref-shared.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
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
  modelCatalogSnapshot?: ModelCatalogSnapshot;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  read: (selection?: Pick<ChatMetadataReadParams, "sessionEntry" | "sessionKey">) => T;
  isCurrent: () => boolean;
};

export async function prepareChatMetadataModelProjection(params: {
  context: GatewayRequestContext;
  facts: ChatMetadataProjectionFacts;
  sessionKey?: string;
  requesterProfileId?: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  runtimeOverride?: string;
  assertCurrent?: () => void;
}): Promise<PreparedAgentProjection<{ models?: ModelChoice[]; allowList?: ModelAllowList }>> {
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
    ...(params.profileProvider ? { profileProvider: params.profileProvider } : {}),
    ...(params.runtimeOverride ? { runtimeOverride: params.runtimeOverride } : {}),
  });
  const [modelCatalog, readModels] = await Promise.all([
    projector.projectCatalog(),
    prepareModelsListResult({
      source: { kind: "gateway", context: params.context },
      agentId: params.facts.agentId,
      params: { view: "configured" },
      ...(params.sessionKey
        ? { readScope: { agentId: params.facts.agentId, sessionKey: params.sessionKey } }
        : {}),
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
    modelCatalogSnapshot: snapshot,
    manifestPlugins: params.facts.owner.metadataSnapshot,
    read: (selection) => {
      const { models, allowList } = readModels.read(selection);
      return { models, ...(allowList ? { allowList } : {}) };
    },
    isCurrent: readModels.isCurrent,
  };
}

export function resolveSessionCatalogProfiles(
  sessionEntry: ChatMetadataSessionEntry | undefined,
  config: OpenClawConfig,
  agentId: string,
  sessionKey?: string,
): {
  sessionKey?: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  runtimeOverride?: string;
} {
  const profileId = sessionEntry?.authProfileOverride?.trim();
  const runtime = sessionEntry?.agentRuntimeOverride?.trim();
  const provider =
    sessionEntry?.providerOverride ??
    (runtime
      ? resolveSessionModelRef(config, sessionEntry, agentId, {
          allowPluginNormalization: false,
          sessionKey,
        }).provider
      : undefined);
  const context = {
    ...(sessionKey && isSubagentSessionKey(sessionKey) ? { sessionKey } : {}),
    ...(provider ? { profileProvider: provider } : {}),
    ...(runtime ? { runtimeOverride: runtime } : {}),
  };
  if (!profileId) {
    return context;
  }
  const profileSource = resolveCollapsedSessionAuthPinSource(sessionEntry);
  return {
    preferredProfileId: profileId,
    ...context,
    ...(profileSource === "user" ? { pinnedProfileId: profileId } : {}),
  };
}

export function sessionProjectionKey(
  agentId: string,
  profiles: ReturnType<typeof resolveSessionCatalogProfiles>,
): string {
  return [
    normalizeAgentId(agentId),
    profiles.preferredProfileId ?? "",
    profiles.pinnedProfileId ?? "",
    profiles.profileProvider ?? "",
    profiles.runtimeOverride ?? "",
    profiles.sessionKey ? "subagent" : "",
  ].join("\0");
}

export function hasSessionCatalogContext(
  profiles: ReturnType<typeof resolveSessionCatalogProfiles>,
) {
  return (
    profiles.preferredProfileId !== undefined ||
    profiles.pinnedProfileId !== undefined ||
    profiles.profileProvider !== undefined ||
    profiles.runtimeOverride !== undefined ||
    profiles.sessionKey !== undefined
  );
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
      sessionKey: readParams.sessionKey,
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
  if (!metadata.models) {
    return metadata;
  }
  return {
    ...metadata,
    models: projectSessionModelCatalog(readParams, metadata.models, config),
  };
}
