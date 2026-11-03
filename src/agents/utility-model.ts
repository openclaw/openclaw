// Resolves the utility model used for short internal tasks (titles, progress
// narration). Unset config derives the provider-declared small model from the
// agent's primary provider; an explicit empty string disables utility routing.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasUtilityModelSeparationMigrationMarker,
  resolveLegacyImplicitPrimaryModelRef,
} from "../config/utility-model-separation-migration.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveNativeModelPrimary } from "./agent-scope.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

/** Published inventory, never configured/static hints, decides automatic selection. */
type OfferedModels = {
  entries: readonly (Pick<
    ModelCatalogEntry,
    "provider" | "id" | "inference" | "contextCapacitySource" | "status"
  > & { available?: boolean })[];
} & Pick<ModelCatalogSnapshot, "authoritative" | "providerOutcomes">;

function isUtilityModelOffered(
  catalog: OfferedModels | undefined,
  provider: string,
  id: string,
  profileId?: string,
) {
  if (!catalog || catalog.authoritative === false) {
    return undefined;
  }
  try {
    const outcomes = catalog.providerOutcomes?.filter(
      (outcome) =>
        normalizeProviderId(outcome.provider) === provider &&
        (!profileId || outcome.profileId === profileId),
    );
    // Retained rows survive acquisition failures; their absence is not a fresh retirement.
    if (outcomes?.some((outcome) => outcome.status !== "ready")) {
      return undefined;
    }
    // Session pins can name a different account than the agent's published inventory.
    if (profileId) {
      const scoped = outcomes;
      if (!scoped?.length) {
        return undefined;
      }
      const listings = scoped.filter((outcome) => outcome.listedModelIds !== undefined);
      if (listings.length && !listings.some((outcome) => outcome.listedModelIds?.includes(id))) {
        return false;
      }
    }
    const rows = catalog.entries.filter(
      (entry) => normalizeProviderId(entry.provider) === provider,
    );
    if (
      !rows.length &&
      !catalog.providerOutcomes?.some(
        (outcome) =>
          normalizeProviderId(outcome.provider) === provider && outcome.status === "ready",
      )
    ) {
      return undefined;
    }
    return rows.some(
      (entry) =>
        entry.id === id &&
        entry.available !== false &&
        entry.inference?.chat !== false &&
        entry.contextCapacitySource !== "unaccepted-starter" &&
        entry.status !== "disabled" &&
        entry.status !== "deprecated",
    );
  } catch {
    // Published catalogs can defer acquisition until their entries are read.
    return undefined;
  }
}

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

/** Automatic selection shared by utility execution and the model-picker preview. */
export function resolveAutomaticUtilityModelRef(params: {
  cfg: OpenClawConfig;
  primaryProvider: string;
  primaryModelRef?: string;
  primaryModelId?: string;
  agentId?: string;
  catalog?: OfferedModels;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): string | undefined {
  return resolveAutomaticUtilityModel(params)?.modelRef;
}

function resolveAutomaticUtilityModel(
  params: Parameters<typeof resolveAutomaticUtilityModelRef>[0],
): { modelRef: string; source: "declared" | "fallback" | "primary" } | undefined {
  const provider = params.primaryProvider.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }
  const snapshot =
    params.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  const primary = params.primaryModelRef
    ? splitTrailingAuthProfile(params.primaryModelRef)
    : undefined;
  const primaryModelId =
    params.primaryModelId?.trim() ||
    (primary?.model.toLowerCase().startsWith(provider + "/")
      ? primary.model.slice(provider.length + 1)
      : undefined);
  // Derived models retain the primary credential; configured fallbacks keep their own owner.
  const withProfile = (modelId: string) =>
    provider + "/" + modelId + (primary?.profile ? "@" + primary.profile : "");
  let declaredModelId: string | undefined;
  let routed = false;
  for (const plugin of snapshot?.plugins ?? []) {
    const declared = plugin.modelCatalog?.providers?.[provider];
    declaredModelId = declared?.defaultUtilityModel?.trim();
    if (declaredModelId) {
      break;
    }
    if (declared?.defaultUtilityModels) {
      routed = true;
      const vendor = primaryModelId?.includes("/")
        ? primaryModelId.slice(0, primaryModelId.indexOf("/")).toLowerCase()
        : undefined;
      declaredModelId = vendor ? declared.defaultUtilityModels[vendor]?.trim() : undefined;
      break;
    }
  }
  const catalog =
    params.catalog ??
    (params.agentId
      ? readPublishedModelCatalog({ config: params.cfg, agentId: params.agentId })
      : undefined);
  const declaredRef = declaredModelId ? withProfile(declaredModelId) : undefined;
  const offered = declaredModelId
    ? isUtilityModelOffered(
        catalog,
        provider,
        declaredModelId,
        routed ? undefined : primary?.profile,
      )
    : undefined;
  // Routers require a positive grant. Ordinary providers retain their preference
  // when discovery is unknown; an acquisition failure is not a model retirement.
  if (declaredRef && (routed ? offered === true : offered !== false)) {
    return { modelRef: declaredRef, source: "declared" };
  }
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  const fallbacks = setting.kind === "disabled" ? [] : setting.fallbacks;
  if (fallbacks.length) {
    // Configured fallback shorthand belongs to the agent primary, not a session override.
    const { provider: defaultProvider } = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      allowPluginNormalization: false,
      manifestPlugins: snapshot?.plugins,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      agentId: params.agentId,
      defaultProvider,
      manifestPlugins: snapshot?.plugins,
    });
    for (const raw of fallbacks) {
      const ref = splitTrailingAuthProfile(raw.trim());
      const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: ref.model,
        defaultProvider,
        aliasIndex,
        manifestPlugins: snapshot?.plugins,
      });
      if (!resolved) {
        continue;
      }
      const fallbackProvider = normalizeProviderId(resolved.ref.provider);
      // Match execution's existing same-provider profile inheritance without
      // transferring a primary account to a different provider or overriding a pin.
      const profile = ref.profile || (fallbackProvider === provider ? primary?.profile : undefined);
      if (isUtilityModelOffered(catalog, fallbackProvider, resolved.ref.model, profile) === false) {
        continue;
      }
      return {
        modelRef: profile && !ref.profile ? ref.model + "@" + profile : raw.trim(),
        source: "fallback",
      };
    }
  }
  if (!routed && declaredRef) {
    if (
      primaryModelId &&
      isUtilityModelOffered(catalog, provider, primaryModelId, primary?.profile) === true
    ) {
      return {
        modelRef: params.primaryModelRef?.trim() || withProfile(primaryModelId),
        source: "primary",
      };
    }
    // Do not silently disable utility work when every alternative is missing:
    // execution owns the actionable missing-model and exhausted-fallback error.
    return { modelRef: declaredRef, source: "declared" };
  }
  return undefined;
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

/**
 * The utility selection and provenance for the agent, or undefined when utility
 * routing is disabled or no default exists. Callers with a session-specific
 * selection pass both primary fields so automatic routing keeps that session's
 * provider and auth owner.
 */
export function resolveUtilityModelSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Pass when the caller already resolved the primary provider. */
  primaryProvider?: string;
  /** Pass with primaryProvider to carry a session-specific auth profile. */
  primaryModelRef?: string;
  /** Resolved model id of primaryProvider when primaryModelRef may be an alias. */
  primaryModelId?: string;
  catalog?: OfferedModels;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): { modelRef: string; source: "config" | "provider-default" } | undefined {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  if (setting.kind === "explicit") {
    return { modelRef: setting.modelRef, source: "config" };
  }
  if (setting.kind === "disabled") {
    return undefined;
  }
  const primary = params.primaryProvider?.trim()
    ? { provider: params.primaryProvider.trim(), model: params.primaryModelId }
    : resolveDefaultModelForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        manifestPlugins: params.metadataSnapshot?.plugins,
      });
  const automatic = resolveAutomaticUtilityModel({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: primary.provider,
    primaryModelRef:
      params.primaryModelRef?.trim() || resolveNativeModelPrimary(params.cfg, params.agentId),
    primaryModelId: primary.model,
    catalog: params.catalog,
    metadataSnapshot: params.metadataSnapshot,
  });
  return automatic
    ? {
        modelRef: automatic.modelRef,
        source: automatic.source === "fallback" ? "config" : "provider-default",
      }
    : undefined;
}

export function resolveUtilityModelRefForAgent(
  params: Parameters<typeof resolveUtilityModelSelectionForAgent>[0],
): string | undefined {
  return resolveUtilityModelSelectionForAgent(params)?.modelRef;
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
  if (!primary.provider || !primary.model || primary.provider.toLowerCase() !== utilityProvider) {
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
  });
  const utilityRef = utilityProvider + "/" + params.utilityModelId.trim().toLowerCase();
  if (
    automatic?.source !== "declared" ||
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
