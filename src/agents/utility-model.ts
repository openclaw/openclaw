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
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

/** The router inventory that proves a routed utility model is offered. */
type OfferedModels = {
  entries: readonly Pick<ModelCatalogEntry, "provider" | "id" | "inference">[];
};

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

/**
 * Automatic utility model for an already-resolved primary provider (manifest
 * `modelCatalog.providers.<id>.defaultUtilityModel`), or undefined when the
 * provider does not declare one. Reads only the process-current plugin
 * metadata snapshot, so the lookup stays synchronous and cheap; contexts
 * without a snapshot simply get no derived default.
 *
 * A multi-vendor router instead declares `defaultUtilityModels` keyed by the
 * vendor prefix of the primary model id (`<vendor>/<model>`). Grants differ per
 * router credential, so that model is chosen only when the router's catalog
 * lists it: the caller's catalog, else the agent's published catalog.
 */
export function resolveAutomaticUtilityModelRef(params: {
  cfg: OpenClawConfig;
  primaryProvider: string;
  primaryModelRef?: string;
  /** Resolved primary model id; defaults to the id in a provider-qualified primaryModelRef. */
  primaryModelId?: string;
  /** Agent whose published catalog proves a routed model is offered. */
  agentId?: string;
  catalog?: OfferedModels;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): string | undefined {
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
  if (!snapshot) {
    return undefined;
  }
  const primary = params.primaryModelRef
    ? splitTrailingAuthProfile(params.primaryModelRef)
    : undefined;
  // Automatic routing stays with the primary model's explicit auth owner.
  const withProfile = (modelId: string) =>
    `${provider}/${modelId}${primary?.profile ? `@${primary.profile}` : ""}`;
  for (const plugin of snapshot.plugins) {
    const declared = plugin.modelCatalog?.providers?.[provider];
    const modelId = declared?.defaultUtilityModel?.trim();
    if (modelId) {
      return withProfile(modelId);
    }
    if (declared?.defaultUtilityModels) {
      const primaryModelId =
        params.primaryModelId?.trim() ||
        (primary?.model.toLowerCase().startsWith(`${provider}/`)
          ? primary.model.slice(provider.length + 1)
          : undefined);
      const vendor = primaryModelId?.includes("/")
        ? primaryModelId.slice(0, primaryModelId.indexOf("/")).trim().toLowerCase()
        : undefined;
      const routedId = vendor ? declared.defaultUtilityModels[vendor]?.trim() : undefined;
      if (!routedId) {
        return undefined;
      }
      const catalog =
        params.catalog ??
        (params.agentId
          ? readPublishedModelCatalog({ config: params.cfg, agentId: params.agentId })
          : undefined);
      // A static decision-only row (chat: false) states protocol support, not a chat grant.
      const offered = catalog?.entries.some(
        (entry) =>
          normalizeProviderId(entry.provider) === provider &&
          entry.id === routedId &&
          entry.inference?.chat !== false,
      );
      return offered ? withProfile(routedId) : undefined;
    }
  }
  return undefined;
}

function readPublishedModelCatalog(params: { config: OpenClawConfig; agentId: string }) {
  const owner = getPublishedPreparedModelCatalogOwnerSnapshot(params);
  return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
}

/**
 * The utility model ref to use for the agent, or undefined when utility
 * routing is disabled or no default exists. Callers with a session-specific
 * selection pass both primary fields so automatic routing keeps that session's
 * provider and auth owner.
 */
export function resolveUtilityModelRefForAgent(params: {
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
}): string | undefined {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  if (setting.kind === "explicit") {
    return setting.modelRef;
  }
  if (setting.kind === "disabled") {
    return undefined;
  }
  const primary = params.primaryProvider?.trim()
    ? { provider: params.primaryProvider.trim(), model: params.primaryModelId }
    : resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  return (
    resolveAutomaticUtilityModelRef({
      cfg: params.cfg,
      agentId: params.agentId,
      primaryProvider: primary.provider,
      primaryModelRef:
        params.primaryModelRef?.trim() || resolveNativeModelPrimary(params.cfg, params.agentId),
      primaryModelId: primary.model,
      catalog: params.catalog,
      metadataSnapshot: params.metadataSnapshot,
    }) ?? setting.fallbacks.find((ref) => ref.trim())?.trim()
  );
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
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const utilityProvider = params.utilityProvider.trim().toLowerCase();
  if (!primary.provider || !primary.model || primary.provider.toLowerCase() !== utilityProvider) {
    return undefined;
  }
  // The observer passes its derived ref back as modelRef. Match that exact model
  // so other same-provider selections keep their own runtime and billing route.
  const automaticRef = resolveAutomaticUtilityModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: primary.provider,
    primaryModelId: primary.model,
    metadataSnapshot: params.metadataSnapshot,
  });
  const utilityRef = `${utilityProvider}/${params.utilityModelId.trim().toLowerCase()}`;
  if (automaticRef?.toLowerCase() !== utilityRef) {
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
