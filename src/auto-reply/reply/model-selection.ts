/** Model selection state for reply runs, including catalog and override handling. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  assertAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAgentConfig,
  resolveAgentDir,
} from "../../agents/agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../../agents/auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveModelProviderAuthConfig } from "../../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import {
  type ModelAliasIndex,
  normalizeProviderId,
  resolveModelAliasFromPair,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
} from "../../agents/openai-routing.js";
import { resolveOperatorModelDefault } from "../../agents/operator-model-policy.js";
import {
  needsThinkHydration,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { hasSessionAutoModelSelection } from "../../config/sessions/model-override-provenance.js";
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
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { ThinkLevel } from "../thinking.shared.js";
import {
  findSelectedCatalogEntry,
  mergePreparedConfiguredCatalog,
  normalizeRuntimeRef,
  resolveRuntimeNormalization,
} from "./model-runtime-normalization.js";
import { isStaleHeartbeatAutoFallbackOverride } from "./stored-model-override.js";
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
  provider: string;
  model: string;
  requestedRouteResolution: ModelFallbackRouteResolution;
  modelPolicy: ModelVisibilityPolicy;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Caller-only selection; auth resolution must preserve shared session pins. */
  operatorModelOverride?: boolean;
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
  modelContextWindow?: number;
  modelContextTokens?: number;
};

const modelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/model-catalog.runtime.js"),
);
const sessionPersistenceRuntimeLoader = createLazyImportLoader(
  () => import("./session-entry-persistence.js"),
);

/** Resolves provider/model, allowlist, catalog, and thinking defaults for a reply run. */
export async function createModelSelectionState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
  isHeartbeat?: boolean;
  preparedModelCatalog?: ModelCatalogSnapshot;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<ModelSelectionState> {
  const operatorAuthority = params.operatorAuthority;
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
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
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    storePath,
    defaultProvider,
    defaultModel,
  } = params;
  const loadRuntimeCatalogSnapshot = async (): Promise<ModelCatalogSnapshot> =>
    params.preparedModelCatalog ??
    (await (
      await modelCatalogRuntimeLoader.load()
    ).loadPreparedModelCatalogSnapshot({
      config: cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      readOnly: true,
    }));
  const runtimeModelNormalization = resolveRuntimeNormalization(cfg);

  let provider = params.provider;
  let model = params.model;
  const primaryProvider = params.primaryProvider ?? defaultProvider;
  const primaryModel = params.primaryModel ?? defaultModel;
  const hasOneTurnModelOverride = params.hasOneTurnModelOverride === true;
  const modelSelectionLocked = sessionEntry?.modelSelectionLocked === true;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;

  const createVisibilityPolicy = (catalog: ModelCatalog) =>
    createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      agentId: params.agentId,
      ...runtimeModelNormalization,
    });
  let visibilityPolicy = createVisibilityPolicy([]);
  const hasAllowlist = !visibilityPolicy.allowAny;
  const hasConfiguredModels =
    Object.keys(agentCfg?.models ?? {}).length > 0 ||
    Object.keys(agentEntry?.models ?? {}).length > 0;
  const defaultModelVisibleByWildcard = visibilityPolicy.allowsByWildcard({
    provider: defaultProvider,
    model: defaultModel,
  });
  const configuredModelCatalog = mergePreparedConfiguredCatalog({
    configured: [...visibilityPolicy.configuredCatalog],
    prepared: params.preparedModelCatalog?.entries,
  });
  const needsModelCatalog =
    params.hasModelDirective ||
    (hasAllowlist && visibilityPolicy.hasProviderWildcards && !defaultModelVisibleByWildcard);

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  // Whether the loaded catalog is a complete/live snapshot. A degraded catalog
  // (discovery threw, static/empty fallback) must not destroy a pinned override.
  let catalogAuthoritative = true;
  let resetModelOverride = false;
  // Set when this call decides to reset the stored override, independent of whether that write
  // persisted. A lost compare-and-swap only means another writer touched the row, not that the
  // refusal should be ignored, so the run's base selection must not stay on the refused ref.
  let storedOverrideResetForRun = false;
  let resetModelOverrideRef: string | undefined;
  let resetModelOverrideReason: "disallowed" | "stale" | "temporarily-unavailable" | undefined;
  const directStoredModelOverride = storedModelOverrides.resolveDirectStoredModelOverride({
    sessionEntry,
    defaultProvider,
    allowPluginNormalization: runtimeModelNormalization.allowPluginNormalization,
    manifestPlugins: runtimeModelNormalization.manifestPlugins,
  });
  const primaryHarnessPolicy = resolveAgentHarnessPolicy({
    provider: primaryProvider,
    modelId: primaryModel,
    config: cfg,
    agentId: params.agentId,
    sessionKey,
  });
  const directOverrideRef = directStoredModelOverride
    ? {
        provider: directStoredModelOverride.provider ?? defaultProvider,
        model: directStoredModelOverride.model,
      }
    : undefined;
  const isStaleStoredOverride = (
    entry: SessionEntry | undefined,
    override: storedModelOverrides.StoredModelOverride | null,
  ) => {
    const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
      isHeartbeat: params.isHeartbeat,
      hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
      sessionEntry: entry,
      storedOverride: override,
      defaultProvider,
      defaultModel,
      primaryProvider: params.primaryProvider,
      primaryModel: params.primaryModel,
    });
    const staleLegacyOpenAICodexAutoOverride =
      override?.source === "session" &&
      entry?.modelOverrideSource === "auto" &&
      normalizeProviderId(override.provider ?? "") === OPENAI_CODEX_PROVIDER_ID &&
      normalizeProviderId(primaryProvider) === OPENAI_PROVIDER_ID &&
      primaryHarnessPolicy.runtime === "codex" &&
      normalizeRuntimeRef(OPENAI_PROVIDER_ID, override.model, runtimeModelNormalization).model ===
        normalizeRuntimeRef(OPENAI_PROVIDER_ID, primaryModel, runtimeModelNormalization).model;
    // Reapplying the current selection must not fight an explicit override.
    const staleLegacyAutoFallbackWithoutOrigin =
      override?.source === "session" &&
      hasLegacyAutoFallbackWithoutOrigin(entry) &&
      (params.provider !== (override.provider ?? defaultProvider) ||
        params.model !== override.model);
    return (
      staleHeartbeatAutoFallbackOverride ||
      staleLegacyOpenAICodexAutoOverride ||
      staleLegacyAutoFallbackWithoutOrigin
    );
  };
  const staleDirectStoredOverride = isStaleStoredOverride(sessionEntry, directStoredModelOverride);

  if (needsModelCatalog) {
    const catalogSnapshot = await loadRuntimeCatalogSnapshot();
    modelCatalog = catalogSnapshot.entries;
    // Only an explicit false is degraded; absent means authoritative.
    catalogAuthoritative = catalogSnapshot.authoritative !== false;
    logStage(
      "catalog-loaded",
      `entries=${modelCatalog.length} authoritative=${catalogAuthoritative}`,
    );
    visibilityPolicy = createVisibilityPolicy(modelCatalog);
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist || hasConfiguredModels || configuredModelCatalog.length > 0) {
    visibilityPolicy = createVisibilityPolicy(configuredModelCatalog);
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  }

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    directOverrideRef &&
    !hasOneTurnModelOverride &&
    (!params.hasModelDirective || !operatorAuthority?.modelPolicy)
  ) {
    const key = buildModelCatalogRef(directOverrideRef.provider, directOverrideRef.model);
    const overrideAllowed =
      hasSessionAutoModelSelection(sessionEntry) || visibilityPolicy.allows(directOverrideRef);
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
      storedOverrideResetForRun = true;
      const initialSessionEntry = { ...sessionEntry };
      const nextSessionEntry = { ...sessionEntry };
      const { updated } = applyModelOverrideToSessionEntry({
        entry: nextSessionEntry,
        selection: { provider: primaryProvider, model: primaryModel, isDefault: true },
        preserveAuthProfileOverride: staleDirectStoredOverride,
      });
      let resetApplied = updated;
      if (updated) {
        if (storePath) {
          const { persistReplySessionEntry } = await sessionPersistenceRuntimeLoader.load();
          const persistence = await persistReplySessionEntry({
            storePath,
            sessionKey,
            initialEntry: initialSessionEntry,
            entry: nextSessionEntry,
            validateCommit: () => {
              operatorAuthority?.assertCurrent();
              return undefined;
            },
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
  // A refused direct override must not stay the run's base selection: `resolveSelection` would clip
  // it to the first allowed catalog entry instead of the configured primary. `stale` has moved to the
  // primary unconditionally since before the reset existed, so it keeps its own signal; a
  // policy-rejected override is moved by the reset decision this owner just took, whether or not that
  // write persisted, and `temporarily-unavailable` preserves the pin instead of resetting it and is
  // deliberately excluded. The ref comparison keeps this to callers that seeded provider/model from
  // the stored override; an inline directive or operator default is resolved afterwards and wins.
  if (
    (storedOverrideResetForRun || staleDirectStoredOverride) &&
    params.provider === directOverrideRef?.provider &&
    params.model === directOverrideRef.model
  ) {
    provider = primaryProvider;
    model = primaryModel;
  }

  const storedOverride = storedModelOverrides.resolveStoredModelOverrideCore({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    defaultProvider,
    allowPluginNormalization: runtimeModelNormalization.allowPluginNormalization,
    manifestPlugins: runtimeModelNormalization.manifestPlugins,
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
  const usesStoredAutomaticSelection =
    !skipStoredOverride &&
    storedOverride?.source === "session" &&
    hasSessionAutoModelSelection(sessionEntry) &&
    !isStaleStoredOverride(sessionEntry, storedOverride);

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
      storedOverride.routeResolution === "raw" && !storedRouteCataloged
        ? resolveModelAliasFromPair({
            cfg,
            provider: storedProvider,
            model: storedOverride.model,
            defaultProvider,
            aliasIndex: visibilityPolicy.selectionAliasIndex,
            ...runtimeModelNormalization,
          })
        : null;
    // A CLI provider names the execution route; a resume binding must not turn it into an API ref.
    const normalizedStoredOverride = storedAlias ?? {
      provider: storedProvider,
      model: storedOverride.model,
    };
    if (
      modelSelectionLocked ||
      usesStoredAutomaticSelection ||
      visibilityPolicy.allows(normalizedStoredOverride)
    ) {
      provider = normalizedStoredOverride.provider;
      model = normalizedStoredOverride.model;
    }
  }

  const skipResolveSelection =
    params.hasModelDirective ||
    hasOneTurnModelOverride ||
    modelSelectionLocked ||
    usesStoredAutomaticSelection;
  if (!skipResolveSelection) {
    const allowedInitialSelection = visibilityPolicy.resolveSelection({
      provider,
      model,
      routeResolution: "resolved",
    });
    if (!allowedInitialSelection) {
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      throw new Error(
        `Configured default model "${buildModelCatalogRef(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
      );
    }
    provider = allowedInitialSelection.provider;
    model = allowedInitialSelection.model;
  }
  let operatorModelOverride = false;
  if (!params.hasModelDirective) {
    const selection =
      hasOneTurnModelOverride || modelSelectionLocked
        ? { provider, model }
        : resolveOperatorModelDefault({
            cfg,
            agentId: params.agentId,
            manifestPlugins: runtimeModelNormalization.manifestPlugins,
            policy: operatorAuthority?.modelPolicy,
            model: { provider, model },
            allows: visibilityPolicy.allows,
          });
    assertOperatorModelAllowed(operatorAuthority, selection);
    if (!selection) {
      throw new Error("No model is available for this operator role and agent.");
    }
    operatorModelOverride = selection.provider !== provider || selection.model !== model;
    provider = selection.provider;
    model = selection.model;
  }

  if (
    !params.skipStoredModelOverride &&
    !operatorModelOverride &&
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride
  ) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(
      params.agentId ? resolveAgentDir(cfg, params.agentId) : undefined,
      {
        allowKeychainPrompt: false,
        profileId: sessionEntry.authProfileOverride,
      },
    );
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const authConfig = resolveModelProviderAuthConfig({ config: cfg, provider, modelId: model });
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
    // Provider aliases must preserve the same credential across native and embedded runtimes.
    const overrideStillEligible =
      profile != null &&
      acceptedAuthProviders.some((accepted) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: authConfig,
          provider: accepted,
          credential: profile,
        }),
      );
    // Admission rejects a missing personal account; clearing its pin here would bill the next participant.
    const missingPersonalProfile =
      !profile && isUserModelAuthProfileId(sessionEntry.authProfileOverride);
    if (!overrideStillEligible && !missingPersonalProfile) {
      await clearSessionAuthProfileOverride({
        agentId: params.agentId,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  const resolveThinkingSelection = (selection: ThinkingDefaultSelection) => {
    const selected = findSelectedCatalogEntry({ ...selection, catalog: visibilityPolicy.catalog });
    return {
      ...selection,
      agentRuntime:
        selection.agentRuntime ??
        resolveEffectiveAgentRuntime({
          cfg,
          provider: selection.provider,
          modelId: selection.model,
          modelApi: selected?.api,
          modelBaseUrl: selected?.baseUrl,
          agentId: params.agentId,
          sessionKey,
          sessionEntry,
        }),
    };
  };
  const thinkingCatalogs = new Map<string, ModelCatalog>();
  const resolveThinkingCatalog = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ) => {
    const thinkingSelection = resolveThinkingSelection(selection);
    const { agentRuntime } = thinkingSelection;
    const key = JSON.stringify([selection.provider, selection.model, agentRuntime]);
    const cached = thinkingCatalogs.get(key);
    if (cached) {
      return cached.length > 0 ? cached : undefined;
    }
    let catalog = visibilityPolicy.catalog;
    if (needsThinkHydration(catalog, selection.provider, selection.model, agentRuntime)) {
      const { loadProviderScopedThinkingCatalog } = await modelCatalogRuntimeLoader.load();
      const preparedCatalog = await loadProviderScopedThinkingCatalog({
        config: cfg,
        agentId: params.agentId,
        provider: selection.provider,
        model: selection.model,
        agentRuntime,
      });
      // An empty refresh cannot replace the admitted owner with a configuration-only row.
      if (findSelectedCatalogEntry({ catalog: preparedCatalog, ...selection })) {
        catalog = createVisibilityPolicy(preparedCatalog).catalog;
      }
    }
    thinkingCatalogs.set(key, catalog);
    return catalog.length > 0 ? catalog : undefined;
  };

  const defaultThinkingLevels = new Map<string, ThinkLevel>();
  const resolveDefaultThinkingLevel = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ) => {
    const thinkingSelection = resolveThinkingSelection(selection);
    const cacheKey = JSON.stringify([
      selection.provider,
      selection.model,
      thinkingSelection.agentRuntime,
    ]);
    const cached = defaultThinkingLevels.get(cacheKey);
    if (cached) {
      return cached;
    }
    const thinkingParams = { cfg, agentId: params.agentId, ...thinkingSelection };
    const resolved =
      resolveConfiguredThinkingDefault(thinkingParams) ??
      resolveThinkingDefault({
        ...thinkingParams,
        catalog: await resolveThinkingCatalog(thinkingSelection),
      });
    defaultThinkingLevels.set(cacheKey, resolved);
    return resolved;
  };

  const hasConfiguredThinkingDefault =
    resolveConfiguredThinkingDefault({
      cfg,
      agentId: params.agentId,
      provider,
      model,
    }) !== undefined;

  const resolveDefaultReasoningLevel = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ): Promise<"on" | "off"> =>
    resolveReasoningDefault({
      provider: selection.provider,
      model: selection.model,
      catalog: await resolveThinkingCatalog(selection),
    });
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: visibilityPolicy.catalog,
    provider,
    model,
  });
  return {
    provider,
    model,
    requestedRouteResolution: "resolved",
    modelPolicy: visibilityPolicy,
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(operatorModelOverride ? { operatorModelOverride } : {}),
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
    modelContextWindow: selectedCatalogEntry?.contextWindow,
    modelContextTokens: selectedCatalogEntry?.contextTokens,
  };
}
