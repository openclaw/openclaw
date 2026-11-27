import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir, resolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  CATALOG_SCAN_YIELD_BUDGET_MS,
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
  type ModelCatalogDecisionParams,
} from "../../agents/model-catalog-decisions.js";
import { createModelPickerRecommendationRank } from "../../agents/model-catalog-order.js";
import { createConfiguredModelCatalogOverridesResolver } from "../../agents/model-catalog-route.js";
import { prepareModelCatalogView } from "../../agents/model-catalog-view.js";
import {
  prepareLogicalVisibleModelCatalog,
  resolveLogicalModelCatalogEntryState,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import {
  omitCliRuntimeAliasTwins,
  resolveCliRuntimeTwinRoute,
  type CliRuntimeTwinRoute,
} from "../../agents/model-runtime-aliases.js";
import { dedupeModelCatalogEntries } from "../../agents/model-selection-shared.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import {
  createModelCatalogIdentityKeyResolver,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../../agents/prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import { resolveProviderModelCatalogId } from "../../plugins/provider-model-routes.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../../shared/current-read-authority.js";
import { loadDeferredCatalog } from "../server-model-catalog-auth.js";
import { prepareChatAccountSelection } from "./chat-account-selection.js";
import type { ChatMetadataSessionEntry } from "./chat-metadata-contract.js";
import { resolveSessionCatalogProfiles } from "./chat-metadata-session-projection.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { createModelsListProviderFilter, listDecisionModels } from "./models-list-capabilities.js";
import { readModelsListCatalog } from "./models-list-catalog.js";
import type { BuildModelsListResultParams } from "./models-list-context.js";
import {
  projectModelCatalogRefreshStatus,
  projectProviderCatalogOutcomes,
} from "./models-list-public-projection.js";
import { resolveDefaultModelsPreview } from "./models-list-result.default-models.js";
import {
  createModelsListPublicProjector,
  prepareModelPickerRuntimeProjection,
} from "./models-list-runtime-choices.js";

type PreparedModelsListResult = {
  read: () => ModelsListResult;
  isCurrent: () => boolean;
};

export async function buildModelsListResult(
  params: BuildModelsListResultParams,
): Promise<ModelsListResult> {
  const prepared = await prepareModelsListResult(params);
  if (!prepared.isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      "Model catalog changed while preparing this result. Retry the request.",
    );
  }
  params.readScope?.draftAccountSelection?.assertCurrent();
  return prepared.read();
}

/** Prepares catalog work once; the returned reader revalidates native readiness without I/O. */
export async function prepareModelsListResult({
  preparationAuthority,
  ...params
}: BuildModelsListResultParams): Promise<PreparedModelsListResult> {
  const { source } = params;
  const scope = params.readScope;
  const publicationScope = params.publicationScope ?? scope;
  const draft = scope?.draftAccountSelection;
  const authority =
    preparationAuthority ??
    (draft
      ? {
          withCurrent: publicationScope?.withCurrent,
          assertCurrent: () => {
            draft.assertCurrent();
            publicationScope?.assertCurrent?.();
          },
        }
      : publicationScope);
  const initialConfig =
    source.kind === "published" ? source.owner.config : source.context.getRuntimeConfig();
  const initialAgentId = resolveAmbientOwnerAgentId(initialConfig, params.agentId);
  const view = params.params.view ?? "default";
  const preloadedCatalog =
    params.preloadedCatalog?.agentId === initialAgentId &&
    preparedModelRuntimeConfigsMatch(params.preloadedCatalog.config, initialConfig)
      ? params.preloadedCatalog
      : undefined;
  // A preloaded projection carries the same owner facts used by session metadata.
  const usedPreloadedCatalog =
    preloadedCatalog !== undefined && params.catalogProjector !== undefined;
  const releaseAccountPrep =
    usedPreloadedCatalog && view !== "provider-config"
      ? params.catalogProjector?.notePendingAccountCatalogPreparation?.()
      : undefined;
  try {
    return await prepareModelsListResultForOwner(
      { ...params, preparationAuthority },
      {
        authority,
        initialConfig,
        initialAgentId,
        view,
        usedPreloadedCatalog,
        releaseAccountPrep,
      },
    );
  } finally {
    releaseAccountPrep?.();
  }
}

async function prepareModelsListResultForOwner(
  params: BuildModelsListResultParams,
  initial: {
    authority: CurrentReadAuthority | undefined;
    initialConfig: ReturnType<typeof captureRuntimeConfig>;
    initialAgentId: string;
    view: NonNullable<BuildModelsListResultParams["params"]["view"]>;
    usedPreloadedCatalog: boolean;
    releaseAccountPrep: (() => void) | undefined;
  },
): Promise<PreparedModelsListResult> {
  const { source } = params;
  const scope = params.readScope;
  const publicationScope = params.publicationScope ?? scope;
  const draft = scope?.draftAccountSelection;
  const { preparationAuthority } = params;
  const {
    authority,
    initialConfig,
    initialAgentId,
    view,
    usedPreloadedCatalog,
    releaseAccountPrep,
  } = initial;
  const sessionEntry: ChatMetadataSessionEntry | undefined = draft
    ? { authProfileOverride: draft.authProfileId, authProfileOverrideSource: "user" }
    : scope?.sessionEntry;
  const useRequesterDefaults = !scope?.sessionKey && !scope?.sessionEntry;
  draft?.assertCurrent();
  const publishedOwner = source.kind === "published" ? source.owner : undefined;
  const profiles = resolveSessionCatalogProfiles(sessionEntry, initialConfig, initialAgentId);
  const refresh = params.params.refresh === true;
  const canYieldDuringPreparation = !(
    (preparationAuthority?.withCurrent !== undefined &&
      preparationAuthority.assertCurrent === undefined) ||
    (publicationScope?.withCurrent !== undefined && publicationScope.assertCurrent === undefined)
  );
  if (source.kind === "gateway" && refresh && !params.preloadedOnly) {
    await loadDeferredCatalog(source.context, initialAgentId, {
      readOnly: false,
      refreshFullCatalog: true,
      ...(params.params.provider ? { providerDiscoveryProviderIds: [params.params.provider] } : {}),
    });
    await withCurrentReadAuthority(authority, () => {});
  }
  const ownerSnapshot =
    source.kind === "gateway" && !usedPreloadedCatalog
      ? await readModelsListCatalog(source.context, initialAgentId, authority)
      : undefined;
  await withCurrentReadAuthority(authority, () => {});
  if (!publishedOwner && !usedPreloadedCatalog && !ownerSnapshot) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    );
  }
  if (
    ownerSnapshot &&
    params.agentId !== undefined &&
    !publishedModelCatalogOwnerMatchesAgent(ownerSnapshot, initialAgentId)
  ) {
    return { read: () => ({ models: [] }), isCurrent: () => true };
  }
  const snapshot =
    publishedOwner?.modelCatalog ??
    (usedPreloadedCatalog ? params.preloadedCatalog?.snapshot : ownerSnapshot);
  if (!snapshot) {
    throw new Error("Model catalog omitted its published snapshot");
  }
  const sourceOwner = publishedOwner ?? ownerSnapshot;
  // Routing consumes one runtime/source pair instead of reprojecting it for every model.
  const cfg = captureRuntimeConfig(sourceOwner?.config ?? initialConfig);
  const agentId = sourceOwner?.agentId ?? initialAgentId;
  const workspaceDir =
    sourceOwner?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const preparedProjectionOwner = sourceOwner ?? params.catalogProjector;
  const metadataSnapshot = preparedProjectionOwner?.metadataSnapshot;
  const preparedAuthStore = preparedProjectionOwner?.authStore;
  const preparedPluginRegistry = preparedProjectionOwner?.pluginRegistry;
  // A prepared owner's registry can differ from the caller's (standalone CLI, workspace
  // generations); preparation resolves plugin facts from the owner. Reads stay pure
  // projections of those prepared facts.
  return withPluginRuntimeRegistryScope(preparedPluginRegistry, async () => {
    const preparedOwnerIsCurrent = preparedProjectionOwner?.isCurrent;
    // Mid-read config changes are best effort. Catalog and account authority still apply.
    const isCurrent = () =>
      preparedOwnerIsCurrent?.() === true && publicationScope?.isCurrent?.() !== false;
    if (!metadataSnapshot || !preparedAuthStore) {
      throw new Error("Gateway model catalog owner omitted prepared metadata or auth state");
    }
    const availableDecisionModels = listDecisionModels({
      config: cfg,
      snapshot: metadataSnapshot,
      catalog: snapshot.entries,
    });
    const selectedModel = resolveSessionModelRef(cfg, scope?.sessionEntry, agentId, {
      allowPluginNormalization: false,
    });
    const retainedModel =
      params.includeManualSelection && view === "configured" && scope?.sessionEntry
        ? selectedModel
        : undefined;
    const preparedCatalog = prepareModelCatalogView({
      cfg,
      agentId,
      agentDir: sourceOwner?.agentDir,
      workspaceDir,
      snapshot,
      view,
      retainedModel,
      metadataSnapshot,
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
    });
    const { defaultModel } = preparedCatalog;
    // Capture authority again after acquisition and before hydrating a personal projection.
    draft?.assertCurrent();
    const decisionOwner = () => ({
      cfg,
      agentId,
      metadataSnapshot,
      preparedAuthStore,
      accountCatalog: preparedProjectionOwner?.accountCatalog,
      preparedRuntimeAuthModes: preparedProjectionOwner?.authModes,
      preparedRuntimeAuthMaterializations: preparedProjectionOwner?.authMaterializations,
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
    });
    const projectorParams: ModelCatalogDecisionParams = {
      ...decisionOwner(),
      agentDir: sourceOwner?.agentDir,
      workspaceDir,
      snapshot: {
        ...snapshot,
        entries: preparedCatalog.catalog,
        get pendingProviders() {
          return snapshot.pendingProviders;
        },
        get refreshFailed() {
          return snapshot.refreshFailed;
        },
      },
      // A complete catalog and its synthetic-auth probes cross the worker boundary together.
      preparedSyntheticAuthComplete: publishedOwner
        ? isPreparedModelCatalogFull(publishedOwner.modelCatalog)
        : ownerSnapshot?.catalogComplete === true,
      // Provider-config inventory describes shared authored configuration, not personal accounts.
      requesterProfileId:
        view === "provider-config" || !useRequesterDefaults
          ? undefined
          : (draft?.owner ?? params.requesterProfileId),
      ...(view === "provider-config" ? {} : profiles),
      routeResolverFactory: params.routeResolverFactory,
    };
    const preloadedProjector = usedPreloadedCatalog ? params.catalogProjector : undefined;
    const projector = preloadedProjector
      ? await withCurrentReadAuthority(authority, () => preloadedProjector)
      : await prepareModelCatalogDecisions(projectorParams, authority);
    try {
      if (view !== "provider-config") {
        await projector.prepareSelectedAccountCatalog(
          () => {
            preparationAuthority?.assertCurrent?.();
            draft?.assertCurrent();
            publicationScope?.assertCurrent?.();
            if (!isCurrent()) {
              throw new PreparedModelRuntimePublicationSupersededError(
                "Selected account catalog changed",
              );
            }
          },
          {
            refresh: refresh && !params.preloadedOnly && !params.params.preparedOnly,
            withCurrent: authority?.withCurrent,
            beforeRequest: publicationScope?.beforeRequest,
          },
        );
      }
    } finally {
      releaseAccountPrep?.();
    }
    await withCurrentReadAuthority(authority, () => {});
    const { routeVariants, providerOutcomes, entries: snapshotEntries } = projector.snapshot;
    const allRows = dedupeModelCatalogEntries([...preparedCatalog.catalog, ...snapshotEntries]);
    const catalog = allRows.filter((entry) => entry.inference?.chat !== false);
    const { evaluateNative } = projector;
    const { normalizeProvider, providerFilter, matchesProvider } = createModelsListProviderFilter({
      config: cfg,
      metadataSnapshot,
      catalog,
      provider: params.params.provider,
    });
    const decisionModels = availableDecisionModels.filter(matchesProvider);
    const publicProviderOutcomes = projectProviderCatalogOutcomes(providerOutcomes);
    const visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      // The policy needs typed-only rows to tell them from refs no catalog knows.
      catalog: allRows,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel,
      agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      manifestPlugins: metadataSnapshot,
    });
    draft?.assertCurrent();
    const modelPreviews = await resolveDefaultModelsPreview({
      cfg,
      agentId,
      agentDir: sourceOwner?.agentDir,
      workspaceDir,
      metadataSnapshot,
      preparedAuthStore,
      preparedRuntimeAuthModes: preparedProjectionOwner?.authModes,
      preparedRuntimeAuthMaterializations: preparedProjectionOwner?.authMaterializations,
      pluginRegistry: preparedPluginRegistry,
      snapshot,
      isCurrent,
      request: params.params,
      view,
    });
    draft?.assertCurrent();
    const outcomeProjection = {
      ...modelPreviews,
      ...(publicProviderOutcomes?.length ? { providerOutcomes: publicProviderOutcomes } : {}),
    };
    const readAccountSelection =
      view === "provider-config" || (!scope && !params.requesterProfileId)
        ? undefined
        : await withCurrentReadAuthority(authority, () =>
            prepareChatAccountSelection({
              authStore: projector.authStore,
              sessionEntry,
              requesterProfileId:
                draft?.owner ?? scope?.requesterProfileId ?? params.requesterProfileId,
            }),
          );
    await withCurrentReadAuthority(authority, () => {});
    const readOutcomeProjection = () => {
      const accountSelection = readAccountSelection?.();
      const isVisibleProvider = (provider: string) =>
        (!providerFilter || normalizeProvider(provider) === providerFilter) &&
        (["all", "provider-config"].includes(view) ||
          visibilityPolicy.allowAny ||
          [...visibilityPolicy.allowedKeys].some((key) => key.startsWith(`${provider}/`)));
      return {
        ...outcomeProjection,
        ...projectModelCatalogRefreshStatus({
          snapshot,
          pendingProviders: projector.snapshot.pendingProviders,
          isVisibleProvider,
        }),
        ...(accountSelection ? { accountSelection } : {}),
        ...(decisionModels.length ? { decisionModels } : {}),
      };
    };
    const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
    const capableProviders = includeProviderCapabilities
      ? resolveModelProviderCapabilities({ config: cfg, metadataSnapshot, workspaceDir })
      : undefined;
    const apiKeyProviders = new Map(
      capableProviders?.capabilities.map(({ provider, apiKeySupported }) => [
        provider,
        apiKeySupported,
      ]),
    );
    const manualSelectionAllowed = params.includeManualSelection
      ? visibilityPolicy.allows
      : undefined;
    const configuredEntriesParams = {
      cfg,
      defaultModel,
      canonicalizeRef: (ref) => ({
        ...ref,
        model:
          resolveProviderModelCatalogId({ provider: ref.provider, modelId: ref.model }) ??
          ref.model,
      }),
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      manifestPlugins: metadataSnapshot,
    } satisfies Parameters<typeof resolveConfiguredModelEntries>[0];
    const configuredEntriesByKey = resolveConfiguredModelEntries({
      ...configuredEntriesParams,
      agentId,
    }).byKey;
    const defaultEntriesByKey =
      modelPreviews &&
      Object.values(cfg.agents?.defaults?.models ?? {}).some(
        (entry) => entry.pickerRuntimes?.length,
      )
        ? resolveConfiguredModelEntries(configuredEntriesParams).byKey
        : undefined;
    const previewDefaultBase = Boolean(
      modelPreviews &&
      Object.values(resolveAgentEntry(cfg, agentId)?.models ?? {}).some(
        ({ agentRuntime }) => agentRuntime,
      ),
    );
    const publicProjection = {
      cfg,
      agentId,
      catalog,
      accountCatalog: preparedProjectionOwner?.accountCatalog,
      includeDetails: params.params.includeDetails,
      view,
      isCurrent,
      metadataSnapshot,
      preparedPluginRegistry,
      configuredEntriesByKey,
      capableProviders,
      apiKeyProviders,
      manualSelectionAllowed,
    };
    const createScanAuthority = (targetDecisions: typeof projector) => {
      const currentChecks = [
        isCurrent,
        () => publicationScope?.isCurrent?.() !== false,
        () => projector.preparedPersonalCatalog?.isCurrent() !== false,
        targetDecisions.isCurrent,
      ];
      let initiallyCurrent: boolean[] | undefined;
      const reassertModelsListPreparationCurrent = () => {
        preparationAuthority?.assertCurrent?.();
        draft?.assertCurrent();
        publicationScope?.assertCurrent?.();
        const capturedInitial = initiallyCurrent;
        if (!capturedInitial) {
          initiallyCurrent = currentChecks.map((check) => check());
          return;
        }
        if (currentChecks.some((check, index) => capturedInitial[index] && !check())) {
          throw new PreparedModelRuntimePublicationSupersededError(
            "Model catalog changed while preparing this result. Retry the request.",
          );
        }
      };
      return {
        withCurrent: authority?.withCurrent,
        assertCurrent: reassertModelsListPreparationCurrent,
      };
    };

    if (view === "provider-config") {
      const sourceConfig = getRuntimeConfigSourceSnapshot() ?? cfg;
      const inventorySnapshot = {
        entries: preparedCatalog.providerInventory(sourceConfig, catalog),
        routeVariants,
        ...(providerOutcomes?.length ? { providerOutcomes } : {}),
      };
      const inventoryProjector = createModelCatalogDecisions({
        ...decisionOwner(),
        snapshot: inventorySnapshot,
        ...(params.routeResolverFactory
          ? { routeResolverFactory: params.routeResolverFactory }
          : {}),
      });
      const scanAuthority = createScanAuthority(inventoryProjector);
      const inventory = await inventoryProjector.projectCatalog(scanAuthority, {
        allowYield: canYieldDuringPreparation,
      });
      const { projectPublic, warmPublicProjection } = createModelsListPublicProjector({
        ...publicProjection,
        decisions: inventoryProjector,
        modelCatalog: inventory,
      });
      const entries = await withCurrentReadAuthority(scanAuthority, async () => {
        const prepared: {
          entry: ModelCatalogEntry;
          host: ModelAuthAvailabilityEvaluation;
        }[] = [];
        let sliceStartMs = canYieldDuringPreparation ? performance.now() : 0;
        for (const entry of inventory) {
          if (
            canYieldDuringPreparation &&
            performance.now() - sliceStartMs >= CATALOG_SCAN_YIELD_BUDGET_MS
          ) {
            await yieldToEventLoop();
            scanAuthority.assertCurrent();
            sliceStartMs = performance.now();
          }
          const host = inventoryProjector.evaluateEntry(entry);
          projector.prepareNativePolicy(entry, host);
          warmPublicProjection(entry, host);
          prepared.push({ entry, host });
        }
        scanAuthority.assertCurrent();
        return prepared;
      });
      return {
        isCurrent: () => isCurrent() && inventoryProjector.isCurrent(),
        read: () => ({
          models: entries
            .filter(({ entry }) => matchesProvider(entry))
            .map(({ entry, host }) => projectPublic(entry, evaluateNative(entry, host))),
          ...readOutcomeProjection(),
        }),
      };
    }
    const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
    const projectRuntimes = new Map<string, (row: ModelChoice) => void>();
    const twinRoutes = new Map<string, CliRuntimeTwinRoute>();
    // Collapsing twins must not hide the only row the agent's manual policy or a role may select.
    const selectionPolicies =
      view === "all"
        ? []
        : [
            visibilityPolicy,
            ...Object.values(cfg.gateway?.roles?.definitions ?? {}).flatMap(
              ({ modelPolicy }) =>
                prepareOperatorModelPolicy({
                  cfg,
                  policy: modelPolicy,
                  manifestPlugins: metadataSnapshot,
                }) ?? [],
            ),
          ];
    const { projectPublic, warmPublicProjection } = createModelsListPublicProjector({
      ...publicProjection,
      decisions: projector,
      modelCatalog: catalog,
    });
    const resolveOverrides = createConfiguredModelCatalogOverridesResolver({ cfg });
    const prepareEntry = (entry: ModelCatalogEntry, variants: readonly ModelCatalogEntry[]) => {
      const key = resolveModelCatalogIdentityKey(entry);
      const twin =
        view === "all"
          ? undefined
          : resolveCliRuntimeTwinRoute(entry, {
              config: cfg,
              agentId,
              cliRuntimeBindings: projector.cliRuntimeBindings,
            });
      if (twin) {
        twinRoutes.set(key, twin);
      }
      const ref = modelKey(entry.provider, entry.id);
      const { host, project } = prepareModelPickerRuntimeProjection({
        cfg,
        agentId,
        entry,
        variants,
        requestedRuntimes: configuredEntriesByKey.get(ref)?.pickerRuntimes,
        defaultRuntimes: defaultEntriesByKey?.get(ref)?.pickerRuntimes,
        previewDefaultBase,
        decisions: projector,
        evaluateNative,
        projectPublic,
        resolveOverrides,
        warmPublicProjection,
      });
      projector.prepareNativePolicy(entry, host);
      warmPublicProjection(entry, host);
      if (project) {
        projectRuntimes.set(key, project);
      }
      return () => {
        const evaluation = evaluateNative(entry, host);
        evaluations.set(key, evaluation);
        const syntheticLocal =
          evaluation.routeResolution === null &&
          normalizeProviderId(entry.provider) !== "openai" &&
          evaluation.availability === undefined &&
          evaluation.evidence === "synthetic";
        return resolveLogicalModelCatalogEntryState({
          evaluation,
          authBacked: evaluation.availability === true || syntheticLocal,
        });
      };
    };
    const scanAuthority = createScanAuthority(projector);
    const readCatalog = await withCurrentReadAuthority(scanAuthority, async () => {
      let sliceStartMs = canYieldDuringPreparation ? performance.now() : 0;
      const read = await prepareLogicalVisibleModelCatalog({
        cfg,
        isCurrent: () => isCurrent() && projector.isCurrent(),
        metadataSnapshot,
        // The all view projects its input rows. Scope per-row auth and runtime preparation
        // while retaining the complete catalog for policy and diagnostics.
        catalog: view === "all" && providerFilter ? catalog.filter(matchesProvider) : catalog,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel,
        agentId,
        workspaceDir,
        view,
        policy: visibilityPolicy,
        retainedModel,
        selectedModel,
        routeVariants,
        prepareEntry: (entry, variants) => {
          if (
            !canYieldDuringPreparation ||
            performance.now() - sliceStartMs < CATALOG_SCAN_YIELD_BUDGET_MS
          ) {
            return prepareEntry(entry, variants);
          }
          return (async () => {
            await yieldToEventLoop();
            scanAuthority.assertCurrent();
            sliceStartMs = performance.now();
            return prepareEntry(entry, variants);
          })();
        },
      });
      scanAuthority.assertCurrent();
      return read;
    });

    return {
      isCurrent: () => isCurrent() && projector.isCurrent(),
      read: () => {
        const currentCatalog = readCatalog();
        const keyOf = createModelCatalogIdentityKeyResolver();
        const recommendationRank = createModelPickerRecommendationRank(cfg);
        return {
          models: omitCliRuntimeAliasTwins(
            currentCatalog.filter(matchesProvider).map((entry) => {
              const key = keyOf(entry);
              const evaluation = evaluations.get(key);
              if (!evaluation) {
                throw new Error("Model catalog publication omitted prepared auth evaluation");
              }
              const projected = projectPublic(entry, evaluation);
              projectRuntimes.get(key)?.(projected);
              if (recommendationRank(entry) !== undefined) {
                projected.recommended = true;
              }
              return { row: projected, twin: twinRoutes.get(key) };
            }),
            selectionPolicies,
          ),
          ...readOutcomeProjection(),
        };
      },
    };
  });
}
