// The utility model decision: config, plugin metadata, the session owner's role
// and a supplied inventory. Reading the published runtime catalog stays with
// `utility-model.ts`, so config validation can ask the same question offline.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveNativeModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

/** Why no utility model runs; `role-policy` never falls back to the main model. */
type UtilityModelDisabledReason = "config" | "role-policy" | "not-offered";
/** A utility model with provenance, or why none runs. */
export type UtilityModelSelection =
  | { modelRef: string; source: "config" | "provider-default" }
  | { disabled: UtilityModelDisabledReason };
type RolePolicy = Pick<PreparedOperatorModelPolicy, "allows">;

/** Published inventory, never configured/static hints, decides automatic selection. */
type OfferedModels = {
  entries: readonly (Pick<
    ModelCatalogEntry,
    "provider" | "id" | "inference" | "contextCapacitySource" | "status"
  > & { available?: boolean })[];
} & Pick<ModelCatalogSnapshot, "authoritative" | "providerOutcomes">;

/** Inputs shared by every automatic selection; `readCatalog` runs only when needed. */
export type AutomaticUtilityModelParams = {
  cfg: OpenClawConfig;
  primaryProvider: string;
  primaryModelRef?: string;
  primaryModelId?: string;
  agentId?: string;
  catalog?: OfferedModels;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  readCatalog?: () => OfferedModels | undefined;
  /** Session owner's role; a refused candidate is never replaced by the main model. */
  modelPolicy?: RolePolicy;
};

/** Selection inputs for one agent; see `resolveUtilityModelSelectionForAgent`. */
export type UtilityModelSelectionParams = {
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
  readCatalog?: () => OfferedModels | undefined;
  modelPolicy?: RolePolicy;
};

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

export function resolveAutomaticUtilityModel(
  params: AutomaticUtilityModelParams,
):
  | { modelRef: string; source: "declared" | "fallback" | "primary" }
  | { disabled: UtilityModelDisabledReason } {
  const provider = params.primaryProvider.trim().toLowerCase();
  if (!provider) {
    return { disabled: "config" };
  }
  const refused = (ref: { provider: string; model: string }) =>
    params.modelPolicy?.allows(ref) === false;
  let roleRefused = false;
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
  const catalog = params.catalog ?? params.readCatalog?.();
  const declaredRef = declaredModelId ? withProfile(declaredModelId) : undefined;
  const offered = declaredModelId
    ? isUtilityModelOffered(
        catalog,
        provider,
        declaredModelId,
        routed ? undefined : primary?.profile,
      )
    : undefined;
  // A role refusal is checked before inventory, so the outcome never depends on
  // whether the catalog has published yet. Policies compare canonical ids, so the
  // declared id resolves like a configured fallback; an unresolvable id is not refused.
  const declaredForPolicy =
    declaredModelId && params.modelPolicy
      ? resolveUtilityRefs({
          cfg: params.cfg,
          agentId: params.agentId,
          raws: [`${provider}/${declaredModelId}`],
          plugins: snapshot?.plugins,
          providerFallback: provider,
        })[0]?.resolved?.ref
      : undefined;
  if (declaredForPolicy && refused(declaredForPolicy)) {
    roleRefused = true;
  } else if (declaredRef && (routed ? offered === true : offered !== false)) {
    // Routers require a positive grant. Ordinary providers retain their preference
    // when discovery is unknown; an acquisition failure is not a model retirement.
    return { modelRef: declaredRef, source: "declared" };
  }
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  const fallbacks = setting.kind === "disabled" ? [] : setting.fallbacks;
  if (fallbacks.length) {
    for (const { raw, split: ref, resolved } of resolveUtilityRefs({
      cfg: params.cfg,
      agentId: params.agentId,
      raws: fallbacks,
      plugins: snapshot?.plugins,
      providerFallback: provider,
    })) {
      if (!resolved) {
        continue;
      }
      const fallbackProvider = normalizeProviderId(resolved.ref.provider);
      // Match execution's existing same-provider profile inheritance without
      // transferring a primary account to a different provider or overriding a pin.
      const profile = ref.profile || (fallbackProvider === provider ? primary?.profile : undefined);
      if (refused({ provider: fallbackProvider, model: resolved.ref.model })) {
        roleRefused = true;
        continue;
      }
      if (isUtilityModelOffered(catalog, fallbackProvider, resolved.ref.model, profile) === false) {
        continue;
      }
      return {
        modelRef: profile && !ref.profile ? ref.model + "@" + profile : raw.trim(),
        source: "fallback",
      };
    }
  }
  // The operator restricted this role; spending the main model would override that.
  if (roleRefused) {
    return { disabled: "role-policy" };
  }
  if (
    !routed &&
    declaredRef &&
    primaryModelId &&
    isUtilityModelOffered(catalog, provider, primaryModelId, primary?.profile) === true
  ) {
    return refused({ provider, model: primaryModelId })
      ? { disabled: "role-policy" }
      : {
          modelRef: params.primaryModelRef?.trim() || withProfile(primaryModelId),
          source: "primary",
        };
  }
  return { disabled: "not-offered" };
}

/** Utility refs resolve like the agent primary's shorthand, never a session override's. */
function resolveUtilityRefs(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  raws: readonly string[];
  plugins: Pick<PluginMetadataSnapshot, "plugins">["plugins"] | undefined;
  providerFallback: string;
}) {
  const defaultProvider =
    resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      allowPluginNormalization: false,
      manifestPlugins: params.plugins,
    })?.provider ?? params.providerFallback;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider,
    manifestPlugins: params.plugins,
  });
  return params.raws.map((raw) => {
    const split = splitTrailingAuthProfile(raw.trim());
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: split.model,
      defaultProvider,
      aliasIndex,
      manifestPlugins: params.plugins,
    });
    return { raw, split, resolved };
  });
}

/** The selection decision behind `resolveUtilityModelSelectionForAgent`. */
export function selectUtilityModel(params: UtilityModelSelectionParams): UtilityModelSelection {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  if (setting.kind === "disabled") {
    return { disabled: "config" };
  }
  if (setting.kind === "explicit") {
    const policy = params.modelPolicy;
    if (!policy) {
      return { modelRef: setting.modelRef, source: "config" };
    }
    // Execution picks among the explicit chain; this only decides whether the
    // role leaves any of it runnable. An unresolvable ref is execution's
    // missing-model error, never a role refusal.
    const runnable = resolveUtilityRefs({
      cfg: params.cfg,
      agentId: params.agentId,
      raws: [setting.modelRef, ...setting.fallbacks],
      plugins: (
        params.metadataSnapshot ??
        getCurrentPluginMetadataSnapshot({ config: params.cfg, allowWorkspaceScopedSnapshot: true })
      )?.plugins,
      providerFallback: DEFAULT_PROVIDER,
    }).some(({ resolved }) => !resolved || policy.allows(resolved.ref));
    return runnable
      ? { modelRef: setting.modelRef, source: "config" }
      : { disabled: "role-policy" };
  }
  const primary = params.primaryProvider?.trim()
    ? { provider: params.primaryProvider.trim(), model: params.primaryModelId }
    : resolveDefaultModelForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        manifestPlugins: params.metadataSnapshot?.plugins,
      });
  // No configured model means no primary to derive a utility model from.
  if (!primary) {
    return { disabled: "config" };
  }
  const automatic = resolveAutomaticUtilityModel({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: primary.provider,
    primaryModelRef:
      params.primaryModelRef?.trim() || resolveNativeModelPrimary(params.cfg, params.agentId),
    primaryModelId: primary.model,
    catalog: params.catalog,
    readCatalog: params.readCatalog,
    metadataSnapshot: params.metadataSnapshot,
    modelPolicy: params.modelPolicy,
  });
  return "modelRef" in automatic
    ? {
        modelRef: automatic.modelRef,
        source: automatic.source === "fallback" ? "config" : "provider-default",
      }
    : automatic;
}
