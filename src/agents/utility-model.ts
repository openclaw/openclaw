// Resolves the utility model used for short internal tasks (titles, progress
// narration). Unset config derives the provider-declared small model from the
// agent's primary provider; an explicit empty string disables utility routing.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasUtilityModelSeparationMigrationMarker,
  resolveLegacyImplicitPrimaryModelRef,
} from "../config/utility-model-separation-migration.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveNativeModelPrimary } from "./agent-scope.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import {
  resolveAutomaticUtilityModel,
  selectUtilityModel,
  type AutomaticUtilityModelParams,
  type UtilityModelSelection,
  type UtilityModelSelectionParams,
} from "./utility-model-selection.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

/** Legacy utility settings did not remove the ordinary implicit primary route. */
export function resolveConfiguredPrimaryModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const primary = resolveNativeModelPrimary(params.cfg, params.agentId)?.trim();
  if (primary) {
    return primary;
  }
  return !hasUtilityModelSeparationMigrationMarker(params.cfg) &&
    readUtilityModelSetting(params.cfg, params.agentId).kind === "explicit"
    ? resolveLegacyImplicitPrimaryModelRef(params.cfg)
    : undefined;
}

/** Setup can use an explicit utility model until the agent has its own primary. */
export function resolveConfiguredSetupModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** An explicit selection verifies only that configuration role. */
  modelTarget?: "primary" | "utility";
}): { modelRef: string; modelTarget?: "utility"; implicitPrimary?: true } | undefined {
  const primary = resolveConfiguredPrimaryModelForAgent(params);
  if (primary && params.modelTarget !== "utility") {
    return {
      modelRef: primary,
      ...(!resolveNativeModelPrimary(params.cfg, params.agentId)?.trim()
        ? { implicitPrimary: true as const }
        : {}),
    };
  }
  if (params.modelTarget === "primary") {
    return undefined;
  }
  const utility = readUtilityModelSetting(params.cfg, params.agentId);
  return utility.kind === "explicit"
    ? { modelRef: utility.modelRef, modelTarget: "utility" }
    : undefined;
}

function readPublishedModelCatalog(params: { config: OpenClawConfig; agentId: string }) {
  try {
    const owner = getPublishedPreparedModelCatalogOwnerSnapshot(params);
    return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
  } catch {
    // A catalog acquisition failure is not proof that a configured model disappeared.
    return undefined;
  }
}

/** The agent's published inventory, read only when automatic selection needs it. */
const publishedCatalogFor = (cfg: OpenClawConfig, agentId: string | undefined) =>
  agentId ? () => readPublishedModelCatalog({ config: cfg, agentId }) : undefined;

/** Automatic selection shared by utility execution and the model-picker preview. */
export function resolveAutomaticUtilityModelRef(
  params: Omit<AutomaticUtilityModelParams, "readCatalog" | "modelPolicy">,
): string | undefined {
  const automatic = resolveAutomaticUtilityModel({
    ...params,
    readCatalog: publishedCatalogFor(params.cfg, params.agentId),
  });
  return "modelRef" in automatic ? automatic.modelRef : undefined;
}

/**
 * The one owner of utility model choice: a selection with provenance, or the
 * reason no utility model runs. Callers with a session-specific selection pass
 * both primary fields so automatic routing keeps that session's provider and
 * auth owner; callers acting for a session owner pass that owner's role policy.
 */
export function resolveUtilityModelSelectionForAgent(
  params: Omit<UtilityModelSelectionParams, "readCatalog">,
): UtilityModelSelection {
  return selectUtilityModel({
    ...params,
    readCatalog: publishedCatalogFor(params.cfg, params.agentId),
  });
}

export function resolveUtilityModelRefForAgent(
  // A ref alone drops the disabled reason, and simple completion would then fall
  // back to the main model; role-aware callers use the selection.
  params: Omit<UtilityModelSelectionParams, "readCatalog" | "modelPolicy">,
): string | undefined {
  const selection = resolveUtilityModelSelectionForAgent(params);
  return "modelRef" in selection ? selection.modelRef : undefined;
}

/** Candidate runtime for an automatic utility model; preparation checks auth availability. */
export function resolveAutomaticUtilityRuntimeOverride(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Provider and model of the already-resolved utility selection. */
  utilityProvider: string;
  utilityModelId: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): string | undefined {
  // An explicit utilityModel owns its own runtime; only automatic routing inherits.
  if (readUtilityModelSetting(params.cfg, params.agentId).kind !== "auto") {
    return undefined;
  }
  const primary = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.metadataSnapshot?.plugins,
  });
  const utilityProvider = params.utilityProvider.trim().toLowerCase();
  if (!primary || primary.provider.toLowerCase() !== utilityProvider) {
    return undefined;
  }
  // The observer passes its derived ref back as modelRef. Match that exact model
  // so other same-provider selections keep their own runtime and billing route.
  const automatic = resolveAutomaticUtilityModel({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: primary.provider,
    primaryModelId: primary.model,
    primaryModelRef: resolveNativeModelPrimary(params.cfg, params.agentId),
    metadataSnapshot: params.metadataSnapshot,
    readCatalog: publishedCatalogFor(params.cfg, params.agentId),
  });
  const utilityRef = utilityProvider + "/" + params.utilityModelId.trim().toLowerCase();
  if (
    !("modelRef" in automatic) ||
    automatic.source !== "declared" ||
    splitTrailingAuthProfile(automatic.modelRef).model.toLowerCase() !== utilityRef
  ) {
    return undefined;
  }
  const derived = resolveAgentHarnessPolicy({
    provider: params.utilityProvider,
    modelId: params.utilityModelId,
    config: params.cfg,
    agentId: params.agentId,
  });
  if (!isDefaultAgentRuntimeId(derived.runtime)) {
    return undefined;
  }
  const primaryPolicy = resolveAgentHarnessPolicy({
    provider: primary.provider,
    modelId: primary.model,
    config: params.cfg,
    agentId: params.agentId,
  });
  // Provider-wide policy already covers the derived model; implicit policy is
  // resolved per route and must not be copied from a different model.
  if (primaryPolicy.runtimeSource !== "model") {
    return undefined;
  }
  return isDefaultAgentRuntimeId(primaryPolicy.runtime) ? undefined : primaryPolicy.runtime;
}
