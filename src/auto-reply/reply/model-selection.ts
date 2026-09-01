/** Model selection state for reply runs, including catalog and override handling. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAgentConfig,
  resolveAutoFallbackPrimaryProbe,
  type AutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../../agents/auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  isModelKeyAllowedBySet,
  parseConfiguredModelVisibilityEntries,
} from "../../agents/model-selection-shared.js";
import {
  type ModelAliasIndex,
  buildConfiguredModelCatalog,
  completeModelRefSelection,
  modelKey,
  normalizeProviderId,
  resolveModelAliasFromPair,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import type { ModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
} from "../../agents/openai-routing.js";
import { resolveAgentModelConfigEntry } from "../../config/model-input.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  hasSessionActiveAutoModelFallback,
  resolveSessionModelOverrideSource,
} from "../../config/sessions/model-override-provenance.js";
import {
  adoptPersistedSessionSnapshot,
  sessionModelOverrideChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import * as storedModelOverrides from "../../sessions/stored-model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeThinkLevel, type ThinkLevel } from "../thinking.shared.js";
import {
  findSelectedCatalogEntry,
  mergePreparedConfiguredCatalog,
  normalizeRuntimeRef,
  resolveRuntimeNormalization,
  type ReplyModelSelection,
} from "./model-runtime-normalization.js";
import {
  isStaleHeartbeatAutoFallbackOverride,
  resolveStoredRuntimeModelRef,
} from "./stored-model-override.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
export { resolveContextTokens } from "./model-selection-context.js";

type ModelCatalog = ModelCatalogEntry[];

type ThinkingDefaultSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
};

type ModelSelectionState = {
  defaultSelection: ReplyModelSelection;
  primarySelection: ReplyModelSelection;
  resolveAutoFallbackPrimaryProbe: () => AutoFallbackPrimaryProbe | undefined;
  provider: string;
  model: string;
  requestedRouteResolution: ModelFallbackRouteResolution;
  modelPolicy: ModelVisibilityPolicy;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  policyAliasIndex: ModelAliasIndex;
  resetModelOverride: boolean;
  resetModelOverrideRef?: string;
  resetModelOverrideReason?: "disallowed" | "stale" | "temporarily-unavailable";
  modelPolicyConfigPath?: string;
  modelPolicyRepairConfigPath?: string;
  resolveThinkingCatalog: (
    selection?: ThinkingDefaultSelection,
  ) => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: (selection?: ThinkingDefaultSelection) => Promise<ThinkLevel>;
  hasConfiguredThinkingDefault?: boolean;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: (selection?: ThinkingDefaultSelection) => Promise<"on" | "off">;
  needsModelCatalog: boolean;
  modelContextWindow?: number;
  modelContextTokens?: number;
};

function resolveConfiguredModelThinkingDefault(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
): ThinkLevel | undefined {
  const raw = resolveAgentModelConfigEntry({
    models: cfg.agents?.defaults?.models,
    provider,
    model,
  }).entry?.params?.thinking;
  if (raw === false || raw === "disabled" || raw === "none") {
    return "off";
  }
  return typeof raw === "string" ? normalizeThinkLevel(raw) : undefined;
}

const modelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/model-catalog.runtime.js"),
);
const sessionPersistenceRuntimeLoader = createLazyImportLoader(
  () => import("./session-entry-persistence.js"),
);

function loadPreparedModelCatalogRuntime() {
  return modelCatalogRuntimeLoader.load();
}

function loadSessionPersistenceRuntime() {
  return sessionPersistenceRuntimeLoader.load();
}

/** Resolves provider/model, allowlist, catalog, and thinking defaults for a reply run. */
export async function createModelSelectionState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  storePath?: string;
  defaultSelection: ReplyModelSelection;
  primarySelection?: ReplyModelSelection;
  selection: ReplyModelSelection;
  hasModelDirective: boolean;
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
  isHeartbeat?: boolean;
  preparedModelCatalog?: ModelCatalogSnapshot;
}): Promise<ModelSelectionState> {
  const timingEnabled = isDiagnosticFlagEnabled("ingress.timing", params.cfg);
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    console.log(
      `[model-selection] session=${params.sessionKey ?? "(no-session)"} stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`,
    );
  };
  const { cfg, agentCfg, sessionEntry, sessionStore, sessionKey, parentSessionKey, storePath } =
    params;
  const loadRuntimeCatalogSnapshot = async (): Promise<ModelCatalogSnapshot> =>
    params.preparedModelCatalog ??
    (await (
      await loadPreparedModelCatalogRuntime()
    ).loadPreparedModelCatalogSnapshot({
      config: cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    }));
  const runtimeModelNormalization = resolveRuntimeNormalization(cfg);
  const { manifestPlugins } = runtimeModelNormalization;

  const configuredModelCatalog = mergePreparedConfiguredCatalog({
    configured: buildConfiguredModelCatalog({ cfg, manifestPlugins }),
    prepared: params.preparedModelCatalog?.entries,
  });
  // These operation-owned copies retain unfinished hooks without mutating the caller's facts.
  const prepareSelection = (selection: ReplyModelSelection): ReplyModelSelection => {
    const prepared = { ...selection };
    if (prepared.routeResolution === "raw" && prepared.normalization === "pending") {
      prepared.ref = completeModelRefSelection(prepared, {
        cfg,
        ...runtimeModelNormalization,
        configuredCatalog: configuredModelCatalog,
        allowPluginNormalization: false,
      });
      prepared.normalization = "applied";
    }
    return prepared;
  };
  const completeSelection = (selection: ReplyModelSelection): ReplyModelSelection => {
    if (selection.routeResolution === "raw") {
      selection.ref = completeModelRefSelection(selection, {
        cfg,
        ...runtimeModelNormalization,
        configuredCatalog: configuredModelCatalog,
      });
      selection.normalization = "applied";
      selection.routeResolution = "resolved";
    }
    return selection;
  };
  const defaultSelection = prepareSelection(params.defaultSelection);
  const primarySelection =
    params.primarySelection && params.primarySelection !== params.defaultSelection
      ? prepareSelection(params.primarySelection)
      : defaultSelection;
  let currentSelection =
    params.selection === params.defaultSelection
      ? defaultSelection
      : params.selection === params.primarySelection
        ? primarySelection
        : prepareSelection(params.selection);
  const hasOneTurnModelOverride = params.hasOneTurnModelOverride === true;
  const modelSelectionLocked = sessionEntry?.modelSelectionLocked === true;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;
  const configuredVisibility = parseConfiguredModelVisibilityEntries({
    cfg,
    agentId: params.agentId,
  });
  const hasConfiguredAllowlist = configuredVisibility.hasEntries;
  // Explicit policy retention and /model handling consume the default identity. An ordinary
  // pinned turn only needs its static provider; completing that unused hook can load a plugin.
  if (hasConfiguredAllowlist || params.hasModelDirective) {
    completeSelection(defaultSelection);
  }
  const hasConfiguredModels =
    Object.keys(agentCfg?.models ?? {}).length > 0 ||
    Object.keys(agentEntry?.models ?? {}).length > 0;
  const defaultProvider = defaultSelection.ref.provider;
  const defaultModelVisibleByWildcard = isModelKeyAllowedBySet(
    configuredVisibility.wildcardModelKeys,
    buildModelCatalogRef(defaultProvider, defaultSelection.ref.model),
  );
  const needsModelCatalog =
    params.hasModelDirective ||
    (hasConfiguredAllowlist &&
      configuredVisibility.wildcardModelKeys.size > 0 &&
      !defaultModelVisibleByWildcard);

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  // Whether the loaded catalog is a complete/live snapshot. A degraded catalog
  // (discovery threw, static/empty fallback) must not destroy a pinned override.
  let catalogAuthoritative = true;
  let resetModelOverride = false;
  let resetModelOverrideRef: string | undefined;
  let resetModelOverrideReason: "disallowed" | "stale" | "temporarily-unavailable" | undefined;
  const directStoredModelOverride = storedModelOverrides.resolveDirectStoredModelOverride({
    cfg,
    sessionEntry,
    defaultProvider,
  });
  // Heartbeat stale-origin checks compare a persisted runtime pair with the actual primary.
  if (
    !modelSelectionLocked &&
    params.isHeartbeat &&
    !params.hasResolvedHeartbeatModelOverride &&
    directStoredModelOverride?.source === "session" &&
    resolveSessionModelOverrideSource(sessionEntry) === "auto"
  ) {
    completeSelection(primarySelection);
  }
  const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
    isHeartbeat: params.isHeartbeat,
    hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
    sessionEntry,
    storedOverride: directStoredModelOverride,
    defaultProvider,
    defaultModel: defaultSelection.ref.model,
    primaryProvider: primarySelection.ref.provider,
    primaryModel: primarySelection.ref.model,
  });
  const staleLegacyOpenAICodexAutoOverride =
    directStoredModelOverride?.source === "session" &&
    sessionEntry?.modelOverrideSource === "auto" &&
    normalizeProviderId(directStoredModelOverride.provider ?? "") === OPENAI_CODEX_PROVIDER_ID &&
    normalizeProviderId(primarySelection.ref.provider) === OPENAI_PROVIDER_ID &&
    resolveAgentHarnessPolicy({
      provider: primarySelection.ref.provider,
      modelId: completeSelection(primarySelection).ref.model,
      config: cfg,
      agentId: params.agentId,
      sessionKey,
    }).runtime === "codex" &&
    normalizeRuntimeRef(
      OPENAI_PROVIDER_ID,
      directStoredModelOverride.model,
      runtimeModelNormalization,
    ).model ===
      normalizeRuntimeRef(OPENAI_PROVIDER_ID, primarySelection.ref.model, runtimeModelNormalization)
        .model;
  if (hasLegacyAutoFallbackWithoutOrigin(sessionEntry)) {
    completeSelection(currentSelection);
  }
  const currentSelectionKey = buildModelCatalogRef(
    currentSelection.ref.provider,
    currentSelection.ref.model,
  );
  const directStoredOverrideKey = directStoredModelOverride
    ? buildModelCatalogRef(
        directStoredModelOverride.provider ?? defaultProvider,
        directStoredModelOverride.model,
      )
    : undefined;
  // A current selection equal to the stored legacy pin deliberately reapplies it; clearing then
  // would fight an explicit override, so only treat differing selections as stale.
  const staleLegacyAutoFallbackWithoutOrigin =
    directStoredModelOverride?.source === "session" &&
    hasLegacyAutoFallbackWithoutOrigin(sessionEntry) &&
    currentSelectionKey !== directStoredOverrideKey;
  const staleDirectStoredOverride =
    staleHeartbeatAutoFallbackOverride ||
    staleLegacyOpenAICodexAutoOverride ||
    staleLegacyAutoFallbackWithoutOrigin;

  if (needsModelCatalog) {
    const catalogSnapshot = await loadRuntimeCatalogSnapshot();
    modelCatalog = catalogSnapshot.entries;
    // Only an explicit false is degraded; absent means authoritative.
    catalogAuthoritative = catalogSnapshot.authoritative !== false;
    logStage(
      "catalog-loaded",
      `entries=${modelCatalog.length} authoritative=${catalogAuthoritative}`,
    );
  }
  // Reply selection consumes authorization, not catalog retention of unused primary/fallback refs.
  const visibilityPolicy = createModelVisibilityPolicyWithFallbacks({
    cfg,
    fallbackModels: [],
    catalog: modelCatalog ?? configuredModelCatalog,
    defaultProvider,
    defaultModel: defaultSelection.ref,
    agentId: params.agentId,
    ...runtimeModelNormalization,
  });
  if (needsModelCatalog || !visibilityPolicy.allowAny || hasConfiguredModels) {
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      needsModelCatalog ? "allowlist-built" : "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (configuredModelCatalog.length > 0) {
    logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
  }

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    directStoredModelOverride &&
    !hasOneTurnModelOverride
  ) {
    const normalizedOverride = resolveStoredRuntimeModelRef(
      directStoredModelOverride.provider ?? defaultProvider,
      directStoredModelOverride.model,
      cfg,
      sessionEntry,
    );
    const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
    const overrideAllowed = visibilityPolicy.allows(normalizedOverride);
    // A degraded catalog cannot prove a pin is disallowed. Preserve it while the turn falls back
    // to primary, then re-evaluate after discovery recovers; config-proven stale pins still reset.
    const shouldResetOverride =
      (staleDirectStoredOverride || !overrideAllowed) && !modelSelectionLocked;
    const overrideTemporarilyUnavailable =
      shouldResetOverride && !staleDirectStoredOverride && !catalogAuthoritative;
    if (overrideTemporarilyUnavailable) {
      resetModelOverrideRef = key;
      resetModelOverrideReason = "temporarily-unavailable";
    } else if (shouldResetOverride) {
      const initialSessionEntry = { ...sessionEntry };
      const nextSessionEntry = { ...sessionEntry };
      const { updated } = applyModelOverrideToSessionEntry({
        entry: nextSessionEntry,
        selection: { ...completeSelection(primarySelection).ref, isDefault: true },
        preserveAuthProfileOverride: staleDirectStoredOverride,
      });
      let resetApplied = updated;
      if (updated) {
        if (storePath) {
          const { persistReplySessionEntry } = await loadSessionPersistenceRuntime();
          const persistence = await persistReplySessionEntry({
            storePath,
            sessionKey,
            initialEntry: initialSessionEntry,
            entry: nextSessionEntry,
          });
          if (persistence.status === "lifecycle-invalidated") {
            throw new SessionWorkStartInvalidatedError(persistence.error);
          }
          const persistedEntry = persistence.entry;
          resetApplied = sessionModelOverrideChangesApplied({
            initial: initialSessionEntry,
            next: nextSessionEntry,
            current: persistedEntry,
          });
          adoptPersistedSessionSnapshot(sessionEntry, persistedEntry);
        } else {
          adoptPersistedSessionSnapshot(sessionEntry, nextSessionEntry);
        }
        sessionStore[sessionKey] = sessionEntry;
      }
      resetModelOverride = resetApplied;
      if (resetApplied) {
        resetModelOverrideRef = key;
        resetModelOverrideReason = staleDirectStoredOverride ? "stale" : "disallowed";
      }
    }
  }
  if (staleDirectStoredOverride && currentSelectionKey === directStoredOverrideKey) {
    currentSelection = primarySelection;
  }

  const storedOverride = storedModelOverrides.resolveStoredModelOverride({
    cfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    defaultProvider,
  });
  // Skip stored session model override only when an explicit heartbeat.model
  // was resolved. Heartbeats without heartbeat.model still inherit normal
  // overrides unless a direct auto fallback override is stale for the current
  // configured default.
  const skipStoredOverride =
    params.skipStoredModelOverride === true ||
    hasOneTurnModelOverride ||
    params.hasResolvedHeartbeatModelOverride === true ||
    (resetModelOverride && staleDirectStoredOverride && storedOverride?.source === "session");

  if (storedOverride?.model && !skipStoredOverride) {
    const storedProvider = storedOverride.provider || defaultProvider;
    const storedRouteCataloged = Boolean(
      findSelectedCatalogEntry({
        catalog: modelCatalog ?? allowedModelCatalog,
        provider: storedProvider,
        model: storedOverride.model,
      }),
    );
    const storedAlias =
      storedOverride.sourceRouteResolution === "raw" && !storedRouteCataloged
        ? resolveModelAliasFromPair({
            cfg,
            provider: storedProvider,
            model: storedOverride.model,
            defaultProvider,
            aliasIndex: visibilityPolicy.selectionAliasIndex,
            ...runtimeModelNormalization,
          })
        : null;
    const normalizedStoredOverride = resolveStoredRuntimeModelRef(
      storedAlias?.provider ?? storedProvider,
      storedAlias?.model ?? storedOverride.model,
      cfg,
      sessionEntry,
    );
    if (modelSelectionLocked || visibilityPolicy.allows(normalizedStoredOverride)) {
      currentSelection = {
        ref: normalizedStoredOverride,
        normalization: "applied",
        routeResolution: "resolved",
      };
    }
  }

  // Stored/locked/turn-local precedence is settled before the chosen route runs its hook.
  let { provider, model } = completeSelection(currentSelection).ref;
  let requestedRouteResolution: ModelFallbackRouteResolution = currentSelection.routeResolution;
  const skipResolveSelection =
    params.hasModelDirective || hasOneTurnModelOverride || modelSelectionLocked;
  if (!skipResolveSelection) {
    const allowedInitialSelection = visibilityPolicy.resolveSelection({
      provider,
      model,
    });
    if (!allowedInitialSelection) {
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      throw new Error(
        `Configured default model "${modelKey(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
      );
    }
    const selectedFallback =
      allowedInitialSelection.provider !== provider || allowedInitialSelection.model !== model;
    ({ provider, model } = selectedFallback
      ? completeModelRefSelection(
          { ref: allowedInitialSelection, normalization: "applied" },
          {
            cfg,
            ...runtimeModelNormalization,
            configuredCatalog: configuredModelCatalog,
          },
        )
      : allowedInitialSelection);
    if (selectedFallback) {
      requestedRouteResolution = "resolved";
    }
  }

  if (
    !params.skipStoredModelOverride &&
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride
  ) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const harnessPolicy = resolveAgentHarnessPolicy({
      provider,
      modelId: model,
      config: cfg,
      agentId: params.agentId,
      sessionKey,
    });
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider,
      harnessRuntime: harnessPolicy.runtime,
      config: cfg,
    }).map(normalizeProviderId);
    // Alias-aware eligibility: a stored credential can be valid for the run
    // provider through provider-auth aliases (e.g. an `anthropic` credential
    // serving a `claude-cli` run). A raw provider-string compare wrongly
    // cleared such overrides, which then let auto-selection re-pick a
    // different profile on a later turn — flapping the CLI session's auth
    // profile and invalidating it. Mirror session-override.ts's check.
    const overrideStillEligible =
      profile != null &&
      acceptedAuthProviders.some((accepted) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg,
          provider: accepted,
          credential: profile,
        }),
      );
    if (!overrideStillEligible) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  let manifestModelCatalog: ModelCatalog | null = null;
  const buildThinkingCatalog = (catalog: ModelCatalog): ModelCatalog =>
    createModelVisibilityPolicyWithFallbacks({
      cfg,
      fallbackModels: [],
      catalog,
      defaultProvider,
      defaultModel: defaultSelection.ref,
      agentId: params.agentId,
      ...runtimeModelNormalization,
    }).allowedCatalog;
  const loadManifestCatalog = async () => {
    if (manifestModelCatalog) {
      return manifestModelCatalog;
    }
    const { loadManifestModelCatalog } = await loadPreparedModelCatalogRuntime();
    manifestModelCatalog = loadManifestModelCatalog({
      config: cfg,
      fallbackToMetadataScan: false,
    });
    logStage("manifest-catalog-loaded", `entries=${manifestModelCatalog.length}`);
    return manifestModelCatalog;
  };
  const thinkingCatalogs = new Map<string, ModelCatalog>();
  const resolveThinkingCatalog = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ) => {
    const key = buildModelCatalogRef(selection.provider, selection.model);
    const cached = thinkingCatalogs.get(key);
    if (cached) {
      return cached.length > 0 ? cached : undefined;
    }
    let catalog = allowedModelCatalog;
    const hasReasoning = (entries: ModelCatalog) =>
      findSelectedCatalogEntry({
        catalog: entries,
        provider: selection.provider,
        model: selection.model,
      })?.reasoning !== undefined;
    if (!hasReasoning(catalog)) {
      const manifestCatalog = buildThinkingCatalog(await loadManifestCatalog());
      if (hasReasoning(manifestCatalog)) {
        catalog = manifestCatalog;
      } else {
        // Capability reads stay scoped to the actual selection, including a model
        // chosen after this state was prepared. Never discover every provider here.
        const { loadProviderScopedThinkingCatalog } = await loadPreparedModelCatalogRuntime();
        const scopedCatalog = buildThinkingCatalog(
          await loadProviderScopedThinkingCatalog({
            config: cfg,
            agentId: params.agentId,
            provider: selection.provider,
            model: selection.model,
          }),
        );
        if (findSelectedCatalogEntry({ catalog: scopedCatalog, ...selection })) {
          catalog = scopedCatalog;
        }
      }
    }
    thinkingCatalogs.set(key, catalog);
    return catalog.length > 0 ? catalog : undefined;
  };

  const defaultThinkingLevels = new Map<string, ThinkLevel>();
  const resolveDefaultThinkingLevel = async (selection?: ThinkingDefaultSelection) => {
    const selectedProvider = selection?.provider ?? provider;
    const selectedModel = selection?.model ?? model;
    const cacheKey = `${buildModelCatalogRef(selectedProvider, selectedModel)}\0${selection?.agentRuntime ?? ""}`;
    const cached = defaultThinkingLevels.get(cacheKey);
    if (cached) {
      return cached;
    }
    const agentThinkingDefault = agentEntry?.thinkingDefault as ThinkLevel | undefined;
    if (agentThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, agentThinkingDefault);
      return agentThinkingDefault;
    }
    const resolvedConfiguredModelThinkingDefault = resolveConfiguredModelThinkingDefault(
      cfg,
      selectedProvider,
      selectedModel,
    );
    if (resolvedConfiguredModelThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, resolvedConfiguredModelThinkingDefault);
      return resolvedConfiguredModelThinkingDefault;
    }
    const configuredThinkingDefault = agentCfg?.thinkingDefault as ThinkLevel | undefined;
    if (configuredThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, configuredThinkingDefault);
      return configuredThinkingDefault;
    }
    const catalogForThinking = await resolveThinkingCatalog(selection);
    const resolved = resolveThinkingDefault({
      cfg,
      provider: selectedProvider,
      model: selectedModel,
      catalog: catalogForThinking,
      agentRuntime: selection?.agentRuntime,
    });
    const defaultThinkingLevel = resolved ?? "off";
    defaultThinkingLevels.set(cacheKey, defaultThinkingLevel);
    return defaultThinkingLevel;
  };

  const resolveDefaultReasoningLevel = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ): Promise<"on" | "off"> =>
    resolveReasoningDefault({
      provider: selection.provider,
      model: selection.model,
      catalog: await resolveThinkingCatalog(selection),
    });
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: modelCatalog ?? allowedModelCatalog,
    provider,
    model,
  });
  const hasConfiguredThinkingDefault =
    agentEntry?.thinkingDefault !== undefined ||
    resolveConfiguredModelThinkingDefault(cfg, provider, model) !== undefined ||
    agentCfg?.thinkingDefault !== undefined;

  return {
    defaultSelection,
    primarySelection,
    resolveAutoFallbackPrimaryProbe: () => {
      if (
        modelSelectionLocked ||
        hasOneTurnModelOverride ||
        params.hasResolvedHeartbeatModelOverride ||
        staleHeartbeatAutoFallbackOverride ||
        !hasSessionActiveAutoModelFallback(sessionEntry)
      ) {
        return undefined;
      }
      const primary = completeSelection(primarySelection).ref;
      return resolveAutoFallbackPrimaryProbe({
        entry: sessionEntry,
        sessionKey,
        primaryProvider: primary.provider,
        primaryModel: primary.model,
      });
    },
    provider,
    model,
    requestedRouteResolution,
    modelPolicy: visibilityPolicy,
    allowedModelKeys,
    allowedModelCatalog,
    policyAliasIndex: visibilityPolicy.policyAliasIndex,
    resetModelOverride,
    resetModelOverrideRef,
    resetModelOverrideReason,
    modelPolicyConfigPath: visibilityPolicy.allowConfigPath ?? undefined,
    modelPolicyRepairConfigPath: visibilityPolicy.allowRepairConfigPath,
    resolveThinkingCatalog,
    resolveDefaultThinkingLevel,
    hasConfiguredThinkingDefault,
    resolveDefaultReasoningLevel,
    needsModelCatalog,
    modelContextWindow: selectedCatalogEntry?.contextWindow,
    modelContextTokens: selectedCatalogEntry?.contextTokens,
  };
}
