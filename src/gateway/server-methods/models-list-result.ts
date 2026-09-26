// Resolves public model catalogs without exposing runtime-only provider params.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelRuntimeChoice,
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import type { ModelCatalogBrowseView } from "../../agents/model-catalog-browse.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
  type ModelCatalogDecisionParams,
} from "../../agents/model-catalog-decisions.js";
import {
  createModelCatalogView,
  selectModelCatalogRuntimeEntry,
  prepareModelCatalogView,
} from "../../agents/model-catalog-view.js";
import {
  resolveLogicalModelCatalogEntryState,
  prepareLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createModelFastModeResolver } from "../../agents/model-fast-mode.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { dedupeModelCatalogEntries } from "../../agents/model-selection-shared.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import {
  createModelCatalogIdentityKeyResolver,
  createOpenAIModelRoutesResolver,
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../../agents/prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveAutomaticUtilityModelRef } from "../../agents/utility-model.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { createThinkingCatalogResolver } from "../../auto-reply/thinking.js";
import { getRuntimeConfig, getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderModelCatalogId } from "../../plugins/provider-model-routes.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import { resolveChatAccountSelection } from "./chat-account-selection.js";
import type { ChatMetadataReadParams, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";
import { resolveSessionCatalogProfiles } from "./chat-metadata-session-projection.js";
import {
  apiKeyProviderCapabilities,
  createModelsListProviderFilter,
  listDecisionModels,
} from "./models-list-capabilities.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";
import {
  buildPublicModelProjection,
  projectProviderCatalogOutcomes,
} from "./models-list-public-projection.js";
import { prepareModelPickerRuntimeChoices } from "./models-list-runtime-choices.js";

type ModelsListEntryWithCapabilities = ModelChoice;
type ApiKeyProviderCapabilities = ReturnType<typeof apiKeyProviderCapabilities>;
type PreparedModelsListResult = {
  read: () => ModelsListResult;
  isCurrent: () => boolean;
};

function resolveModelsListView(params: Record<string, unknown>): ModelCatalogBrowseView {
  const view = params.view;
  return view === "configured" || view === "provider-config" || view === "all" ? view : "default";
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: ModelCatalogDecisionParams) {
  const authProjection = createModelCatalogDecisions(params);
  const { evaluateEntry, evaluateNative, snapshot } = authProjection;
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    ...authProjection,
    projectCatalog: () => {
      if (projectedCatalog) {
        return projectedCatalog;
      }
      const view = createModelCatalogView({
        cfg: params.cfg,
        catalog: snapshot.entries,
        routeVariants:
          snapshot.routeVariants.length > 0 ? snapshot.routeVariants : snapshot.entries,
      });
      return (projectedCatalog = Promise.all(
        view.logicalEntries.map(async (entry) => {
          const routeVariants = view.variantsOf(entry) ?? [entry];
          const evaluation = evaluateNative(entry, await evaluateEntry(entry, routeVariants));
          const runtimeId =
            resolveCatalogDecisionRuntime({
              cfg: params.cfg,
              agentId: params.agentId,
              entry,
              evaluation,
              pluginRegistry: params.pluginRegistry,
            })?.id ?? "openclaw";
          const selected = selectModelCatalogRuntimeEntry({ entry, routeVariants, runtimeId });
          return view.project(selected.entry, evaluation, selected.variants).runtimeEntry;
        }),
      ));
    },
  };
}

function createPublicModelsListProjector(params: {
  pluginRegistry?: ModelCatalogDecisionParams["pluginRegistry"];
  thinkingCatalog: ModelCatalogEntry[];
  fastMode: ReturnType<typeof createModelFastModeResolver>;
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  configuredTagsByKey?: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  includeInput?: boolean;
  includeDetails?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
  manualSelectionAllowed?: ModelVisibilityPolicy["allows"];
}) {
  const catalogResolver = createThinkingCatalogResolver(params.thinkingCatalog);
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, Map<string, ModelsListEntryWithCapabilities>>();
  return (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeChoice?: string,
  ): ModelsListEntryWithCapabilities => {
    const runtimeKey = runtimeChoice ?? "";
    let preparedEntry = prepared.get(entry)?.get(runtimeKey);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
      const tags = (params.configuredTagsByKey ?? params.configuredEntriesByKey).get(
        modelKey(entry.provider, entry.id),
      )?.tags;
      const alias = configuredEntry?.aliases.at(-1);
      const publicEntry = configuredEntry?.aliasDisabled
        ? Object.assign({}, entry, { alias: undefined })
        : alias && alias !== entry.alias
          ? Object.assign({}, entry, { alias })
          : entry;
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const selectedRuntime = runtimeChoice
        ? { id: runtimeChoice, source: "model" as const }
        : resolveCatalogDecisionRuntime({
            cfg: params.cfg,
            agentId: params.agentId,
            entry,
            evaluation,
            pluginRegistry: params.pluginRegistry,
          });
      const agentRuntime = selectedRuntime
        ? params.pluginRegistry
          ? withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
              projectWorkerPlacementAgentRuntime(selectedRuntime),
            )
          : projectWorkerPlacementAgentRuntime(selectedRuntime)
        : undefined;
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              agentRuntime: selectedRuntime?.id ?? "openclaw",
              modelCatalog: runtimeChoice ? [entry] : params.thinkingCatalog,
              catalogResolver: runtimeChoice
                ? createThinkingCatalogResolver([entry])
                : catalogResolver,
              configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
              thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
            });
      const fastModeState = resolveFastModeState({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: entry.provider,
        model: entry.id,
      });
      preparedEntry = {
        ...buildPublicModelProjection(publicEntry, { includeDetails: params.includeDetails }),
        ...(tags?.size ? { tags: [...tags] } : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...thinkingProfile,
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && params.apiKeyCapabilities?.providers.has(capabilityProvider)
          ? {
              apiKeySupported: params.apiKeyCapabilities.providers.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
      };
      const entries = prepared.get(entry) ?? new Map<string, ModelsListEntryWithCapabilities>();
      entries.set(runtimeKey, preparedEntry);
      prepared.set(entry, entries);
    }
    // Legacy views require a boolean; inventory consumers preserve unknown state.
    const projectedAvailability = params.preserveUnknownAvailability
      ? evaluation.availability
      : (evaluation.availability ?? false);
    const supportsFastMode = params.fastMode(entry, evaluation, preparedEntry.agentRuntime?.id);
    return Object.assign(
      {},
      preparedEntry,
      params.manualSelectionAllowed
        ? {
            manualSelectionAllowed: params.manualSelectionAllowed({
              provider: entry.provider,
              model: entry.id,
            }),
          }
        : {},
      supportsFastMode === undefined ? {} : { supportsFastMode },
      projectedAvailability === undefined ? {} : { available: projectedAvailability },
      projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {},
    );
  };
}

type ModelsListCatalogSource =
  | {
      kind: "gateway";
      context: GatewayModelCatalogContext;
    }
  | {
      kind: "published";
      owner: ResolvedPublishedModelCatalogOwner & {
        authMaterializations: readonly RuntimeAuthMaterialization[];
      };
    };

type BuildModelsListResultParams = {
  source: ModelsListCatalogSource;
  agentId?: string;
  requesterProfileId?: string;
  readScope?: ChatMetadataReadParams;
  params: ModelsListParams;
  includeManualSelection?: boolean;
  preloadedCatalog?: {
    agentId: string;
    config: OpenClawConfig;
    snapshot: ModelCatalogSnapshot;
  };
  catalogProjector?: ReturnType<typeof createGatewayAgentModelCatalogProjector>;
  preloadedOnly?: boolean;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
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
export async function prepareModelsListResult(
  params: BuildModelsListResultParams,
): Promise<PreparedModelsListResult> {
  const { source } = params;
  const scope = params.readScope;
  const draft = scope?.draftAccountSelection;
  const sessionEntry: ChatMetadataSessionEntry | undefined = draft
    ? { authProfileOverride: draft.authProfileId, authProfileOverrideSource: "user" }
    : scope?.sessionEntry;
  const useRequesterDefaults = !scope?.sessionKey && !scope?.sessionEntry;
  draft?.assertCurrent();
  const currentConfig =
    source.kind === "gateway" ? source.context.getRuntimeConfig : getRuntimeConfig;
  const publishedOwner = source.kind === "published" ? source.owner : undefined;
  const requestConfig = currentConfig();
  const initialConfig = publishedOwner?.config ?? requestConfig;
  const initialAgentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(initialConfig));
  const profiles = resolveSessionCatalogProfiles(sessionEntry, initialConfig, initialAgentId);
  const view = resolveModelsListView(params.params);
  const refresh = params.params.refresh === true;
  const preloadedCatalog =
    params.preloadedCatalog?.agentId === initialAgentId &&
    preparedModelRuntimeConfigsMatch(params.preloadedCatalog.config, initialConfig)
      ? params.preloadedCatalog
      : undefined;
  // A preloaded projection carries the same owner facts used by session metadata.
  const usedPreloadedCatalog =
    preloadedCatalog !== undefined && params.catalogProjector !== undefined;
  if (source.kind === "gateway" && refresh && !params.preloadedOnly) {
    await loadDeferredCatalog(source.context, initialAgentId, {
      readOnly: false,
      refreshFullCatalog: true,
      ...(params.params.provider ? { providerDiscoveryProviderIds: [params.params.provider] } : {}),
    });
  }
  const ownerSnapshot =
    source.kind === "gateway" && !usedPreloadedCatalog
      ? await readPreparedCatalog(source.context, initialAgentId)
      : undefined;
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
    (usedPreloadedCatalog ? preloadedCatalog.snapshot : ownerSnapshot);
  if (!snapshot) {
    throw new Error("Model catalog omitted its published snapshot");
  }
  const sourceOwner = publishedOwner ?? ownerSnapshot;
  const cfg = sourceOwner?.config ?? initialConfig;
  const agentId = sourceOwner?.agentId ?? initialAgentId;
  const workspaceDir =
    sourceOwner?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const preparedProjectionOwner = sourceOwner ?? params.catalogProjector;
  const metadataSnapshot = preparedProjectionOwner?.metadataSnapshot;
  const preparedAuthStore = preparedProjectionOwner?.authStore;
  const preparedPluginRegistry = preparedProjectionOwner?.pluginRegistry;
  const preparedOwnerIsCurrent = preparedProjectionOwner?.isCurrent;
  // Native readiness belongs to the prepared generation, even across config publication.
  const isCurrent = () =>
    currentConfig() === requestConfig &&
    preparedOwnerIsCurrent?.() === true &&
    scope?.isCurrent?.() !== false;
  if (!metadataSnapshot || !preparedAuthStore) {
    throw new Error("Gateway model catalog owner omitted prepared metadata or auth state");
  }
  const availableDecisionModels = listDecisionModels({
    config: cfg,
    snapshot: metadataSnapshot,
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
  const preparedRuntimeAuthModes = preparedProjectionOwner?.authModes;
  const preparedRuntimeAuthMaterializations = preparedProjectionOwner?.authMaterializations;
  // Capture authority again after acquisition and before hydrating a personal projection.
  draft?.assertCurrent();
  const projector =
    (usedPreloadedCatalog ? params.catalogProjector : undefined) ??
    createGatewayAgentModelCatalogProjector({
      cfg,
      agentId,
      agentDir: sourceOwner?.agentDir,
      workspaceDir,
      snapshot: { ...snapshot, entries: preparedCatalog.catalog },
      metadataSnapshot,
      preparedAuthStore,
      preparedRuntimeAuthModes,
      preparedRuntimeAuthMaterializations,
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
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
    });
  const catalog = dedupeModelCatalogEntries([
    ...preparedCatalog.catalog,
    ...projector.snapshot.entries,
  ]);
  const evaluateNative: typeof projector.evaluateNative = (entry, host, runtimeId) => {
    const native = projector.evaluateNative(entry, host, runtimeId);
    return native !== host && currentConfig() !== requestConfig
      ? { ...native, availability: false }
      : native;
  };
  const { normalizeProvider, providerFilter, matchesProvider } = createModelsListProviderFilter({
    config: cfg,
    metadataSnapshot,
    catalog,
    provider: params.params.provider,
  });
  const decisionModels = availableDecisionModels.filter(matchesProvider);
  const { routeVariants, providerOutcomes } = projector.snapshot;
  const publicProviderOutcomes = projectProviderCatalogOutcomes(providerOutcomes);
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  });
  const pendingProviders = projector.snapshot.pendingProviders?.filter(
    (provider) =>
      (!providerFilter || normalizeProvider(provider) === providerFilter) &&
      (view === "all" ||
        view === "provider-config" ||
        visibilityPolicy.allowAny ||
        [...visibilityPolicy.allowedKeys].some((key) => key.startsWith(`${provider}/`))),
  );
  draft?.assertCurrent();
  const outcomeProjection = {
    ...(pendingProviders?.length ? { pendingProviders } : {}),
    ...((params.params.includeDefaultModels ??
    (view === "configured" && !params.params.sessionKey && !params.params.authProfileId))
      ? {
          defaultModels: {
            automaticUtilityModel:
              resolveAutomaticUtilityModelRef({
                cfg,
                primaryProvider: resolveDefaultModelForAgent({
                  cfg,
                  manifestPlugins: metadataSnapshot,
                  allowPluginNormalization: false,
                }).provider,
                primaryModelRef: resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
                metadataSnapshot,
              }) ?? null,
          },
        }
      : {}),
    ...(publicProviderOutcomes?.length ? { providerOutcomes: publicProviderOutcomes } : {}),
    ...(snapshot.refreshFailed ? { refreshFailed: true } : {}),
    ...(view === "provider-config" || (!scope && !params.requesterProfileId)
      ? {}
      : {
          accountSelection: resolveChatAccountSelection({
            authStore: projector.authStore,
            sessionEntry,
            requesterProfileId:
              draft?.owner ?? scope?.requesterProfileId ?? params.requesterProfileId,
          }),
        }),
  };
  const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
  const capableProviders = includeProviderCapabilities
    ? apiKeyProviderCapabilities({ cfg, metadataSnapshot, workspaceDir })
    : undefined;
  const configuredEntryOptions: Parameters<typeof resolveConfiguredModelEntries>[0] = {
    cfg,
    canonicalizeRef: (ref) => ({
      ...ref,
      model:
        resolveProviderModelCatalogId({ provider: ref.provider, modelId: ref.model }) ?? ref.model,
    }),
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  };
  const configuredEntriesByKey = resolveConfiguredModelEntries({
    ...configuredEntryOptions,
    agentId,
    defaultModel,
  }).byKey;
  if (view === "provider-config") {
    const sourceConfig = getRuntimeConfigSourceSnapshot() ?? cfg;
    const inventorySnapshot = {
      entries: preparedCatalog.providerInventory(sourceConfig, catalog),
      routeVariants,
      ...(providerOutcomes?.length ? { providerOutcomes } : {}),
    };
    const inventoryProjector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId,
      snapshot: inventorySnapshot,
      metadataSnapshot,
      preparedAuthStore,
      preparedRuntimeAuthModes,
      preparedRuntimeAuthMaterializations,
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
      ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
    });
    const inventory = await inventoryProjector.projectCatalog();
    const entries = await Promise.all(
      inventory.map(async (entry) => ({
        entry,
        host: await inventoryProjector.evaluateEntry(entry),
      })),
    );
    const projectPublic = createPublicModelsListProjector({
      pluginRegistry: preparedPluginRegistry,
      thinkingCatalog: catalog,
      fastMode: createModelFastModeResolver({
        cfg,
        agentId,
        catalog: inventory,
        metadataSnapshot,
        pluginRegistry: preparedPluginRegistry,
      }),
      cfg,
      agentId,
      configuredEntriesByKey,
      // Inventory roles describe shared defaults; aliases and execution stay agent-scoped.
      configuredTagsByKey: resolveConfiguredModelEntries(configuredEntryOptions).byKey,
      ...(params.includeManualSelection ? { manualSelectionAllowed: visibilityPolicy.allows } : {}),
      includeInput: true,
      includeDetails: params.params.includeDetails,
      preserveUnknownAvailability: true,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    });
    return {
      isCurrent: () => isCurrent() && inventoryProjector.isCurrent(),
      read: () => ({
        tagsScope: "defaults",
        models: entries
          .filter(({ entry }) => matchesProvider(entry))
          .map(({ entry, host }) => projectPublic(entry, evaluateNative(entry, host))),
        ...outcomeProjection,
        ...(decisionModels.length ? { decisionModels } : {}),
      }),
    };
  }
  const { evaluateEntry } = projector;
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const runtimeChoiceReaders = new Map<string, () => ModelRuntimeChoice[]>();
  const projectPublic = createPublicModelsListProjector({
    pluginRegistry: preparedPluginRegistry,
    thinkingCatalog: catalog,
    fastMode: createModelFastModeResolver({
      cfg,
      agentId,
      catalog,
      metadataSnapshot,
      pluginRegistry: preparedPluginRegistry,
    }),
    cfg,
    agentId,
    configuredEntriesByKey,
    ...(params.includeManualSelection ? { manualSelectionAllowed: visibilityPolicy.allows } : {}),
    includeDetails: params.params.includeDetails,
    preserveUnknownAvailability: params.params.includeDetails,
    ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
  });
  const readCatalog = await prepareLogicalVisibleModelCatalog({
    cfg,
    metadataSnapshot,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    workspaceDir,
    view,
    policy: visibilityPolicy,
    retainedModel,
    selectedModel,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants,
    prepareEntry: async (entry, variants) => {
      const key = resolveModelCatalogIdentityKey(entry);
      const requestedRuntimes = configuredEntriesByKey.get(
        modelKey(entry.provider, entry.id),
      )?.pickerRuntimes;
      const baseRuntime = requestedRuntimes?.length
        ? resolveAgentHarnessPolicy({
            config: cfg,
            agentId,
            provider: entry.provider,
            modelId: entry.id,
            modelApi: entry.api,
            modelBaseUrl: entry.baseUrl,
          }).runtime
        : undefined;
      const preparedHost = await evaluateEntry(entry, variants, baseRuntime);
      // Picker alternatives never change the configured row when a session selects a sibling.
      const host = baseRuntime ? { ...preparedHost, requestedRuntimeId: undefined } : preparedHost;
      if (requestedRuntimes?.length) {
        runtimeChoiceReaders.set(
          key,
          await prepareModelPickerRuntimeChoices({
            cfg,
            agentId,
            entry,
            variants,
            requestedRuntimes,
            baseEvaluation: evaluateNative(entry, host),
            decisions: projector,
            evaluateNative,
            projectPublic,
          }),
        );
      }
      return () => {
        const evaluation = evaluateNative(entry, host);
        evaluations.set(resolveModelCatalogIdentityKey(entry), evaluation);
        const routeManaged = evaluation.routeResolution !== null;
        const syntheticLocal =
          !routeManaged &&
          normalizeProviderId(entry.provider) !== "openai" &&
          evaluation.availability === undefined &&
          evaluation.evidence === "synthetic";
        return resolveLogicalModelCatalogEntryState({
          evaluation,
          authBacked: evaluation.availability === true || syntheticLocal,
          routePolicy: openAIModelCatalogRoutePolicy,
        });
      };
    },
  });

  return {
    isCurrent: () => isCurrent() && projector.isCurrent(),
    read: () => {
      const currentCatalog = readCatalog();
      const keyOf = createModelCatalogIdentityKeyResolver();
      return {
        models: currentCatalog.filter(matchesProvider).map((entry) => {
          const key = keyOf(entry);
          const evaluation = evaluations.get(key);
          if (!evaluation) {
            throw new Error("Model catalog publication omitted prepared auth evaluation");
          }
          const runtimeChoices = runtimeChoiceReaders.get(key)?.();
          const projected = projectPublic(entry, evaluation);
          if (runtimeChoices?.length) {
            projected.runtimeChoices = runtimeChoices;
          }
          return projected;
        }),
        ...outcomeProjection,
        ...(decisionModels.length ? { decisionModels } : {}),
      };
    },
  };
}
