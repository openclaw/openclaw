import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveGatewaySessionRuntimeSelectionLocked } from "../session-utils-projection.js";
import { workerInferenceMetadata } from "../worker-environments/inference-placement.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";

export type ChatMetadataProjectionFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
  modelCatalog: ModelCatalogSnapshot;
};

export async function prepareSessionAcpMeta(
  params: Pick<ChatMetadataReadParams, "agentId" | "sessionKey" | "sessionEntry">,
  cfg: OpenClawConfig,
): Promise<SessionAcpMeta | null> {
  if (!params.sessionKey) {
    return null;
  }
  const [meta] = await readAcpSessionMetaForEntries({
    cfg,
    entries: [
      { agentId: params.agentId, sessionKey: params.sessionKey, entry: params.sessionEntry },
    ],
  });
  return meta ?? null;
}

export async function prepareChatMetadataModelProjection(params: {
  context: GatewayModelCatalogContext;
  facts: ChatMetadataProjectionFacts;
  requesterProfileId?: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  runtimeOverride?: string;
  assertCurrent?: () => void;
}): Promise<{
  modelCatalog: ModelCatalogEntry[];
  read: () => { models?: ModelChoice[] };
  isCurrent: () => boolean;
}> {
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
    accountCatalog: params.facts.owner.accountCatalog,
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

export function resolveSessionCatalogProfiles(
  sessionEntry: ChatMetadataSessionEntry | undefined,
  config: OpenClawConfig,
  agentId: string,
): {
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
        }).provider
      : undefined);
  const context = {
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
  ].join("\0");
}

export function hasSessionCatalogContext(
  profiles: ReturnType<typeof resolveSessionCatalogProfiles>,
) {
  return (
    profiles.preferredProfileId !== undefined ||
    profiles.pinnedProfileId !== undefined ||
    profiles.profileProvider !== undefined ||
    profiles.runtimeOverride !== undefined
  );
}

function resolveRequiredWorkerInferenceProfileId(
  readParams: ChatMetadataReadParams,
  config: OpenClawConfig,
): string | undefined {
  const required = config.cloudWorkers?.requiredProfile;
  const profile = required ? config.cloudWorkers?.profiles?.[required] : undefined;
  const runtime =
    resolveSessionPinnedHarnessId(readParams.sessionEntry) ??
    normalizeOptionalAgentRuntimeId(readParams.sessionEntry?.agentRuntimeOverride);
  // A required worker owns the next session turn even before its placement exists.
  // This is send metadata, not admission or a claim that the node is ready: dispatch
  // still validates the actual placement, runtime, build, workspace and model grant.
  // Agent-wide/explicit-account picker reads keep their Gateway availability facts.
  return readParams.sessionKey &&
    (isDefaultAgentRuntimeId(runtime) || runtime === "openclaw") &&
    profile &&
    workerInferenceMetadata({ providerId: profile.provider, profileSnapshot: profile }).inference
    ? required
    : undefined;
}

// Read native ownership after profile projection; never cache this session overlay.
export function projectSessionModelCatalog(
  readParams: ChatMetadataReadParams,
  models: ModelChoice[],
  config: OpenClawConfig,
): ModelChoice[] {
  const ownership = readSessionRuntimeOwnership({ ...readParams, config });
  const requiredWorker = resolveRequiredWorkerInferenceProfileId(readParams, config);
  const nativeAuth = ownership?.auth === "native";
  const entry = readParams.sessionEntry;
  const workerAuth =
    (readParams.workerInference === "worker" || requiredWorker !== undefined) &&
    !entry?.modelOverride?.trim() &&
    !entry?.agentRuntimeOverride?.trim() &&
    !(entry?.authProfileOverride?.trim() && entry.authProfileOverrideSource === "user");
  if (!nativeAuth && !workerAuth) {
    return models;
  }
  // Pending native branches have no tuple. Worker inference uses the configured ambient model;
  // explicit model, runtime, and personal-account choices retain Gateway availability checks.
  const renderedModel =
    ownership?.modelRef ??
    resolveSessionModelRef(config, readParams.sessionEntry, readParams.agentId, {
      allowPluginNormalization: false,
    });
  return models.map((model) => {
    if (model.provider !== renderedModel.provider || model.id !== renderedModel.model) {
      return model;
    }
    if (
      workerAuth &&
      model.unavailableReason !== "missing-auth" &&
      model.unavailableReason !== "auth-failed"
    ) {
      return model;
    }
    const {
      available: _available,
      unavailableReason: _reason,
      unavailableUntil: _until,
      ...available
    } = model;
    return available;
  });
}

export function projectChatSessionMetadata(
  readParams: ChatMetadataReadParams,
  metadata: ChatMetadataResult,
  config: OpenClawConfig,
  preparedAcpMeta: SessionAcpMeta | null,
): ChatMetadataResult {
  const projected = metadata.models
    ? { ...metadata, models: projectSessionModelCatalog(readParams, metadata.models, config) }
    : metadata;
  if (!readParams.sessionKey) {
    return projected;
  }
  const entry = readParams.sessionEntry;
  return {
    ...projected,
    runtimeSelectionLocked: resolveGatewaySessionRuntimeSelectionLocked(
      entry,
      preparedAcpMeta ?? undefined,
    ),
    requiredWorkerInferenceProfileId: resolveRequiredWorkerInferenceProfileId(readParams, config),
  };
}
