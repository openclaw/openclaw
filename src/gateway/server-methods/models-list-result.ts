import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelRuntimeChoice,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
  type ModelCatalogDecisionParams,
} from "../../agents/model-catalog-decisions.js";
import { prepareModelCatalogView } from "../../agents/model-catalog-view.js";
import {
  resolveLogicalModelCatalogEntryState,
  prepareLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createModelSpeedPolicyResolver } from "../../agents/model-fast-mode.js";
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
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { createThinkingCatalogResolver } from "../../auto-reply/thinking.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import { resolveProviderModelCatalogId } from "../../plugins/provider-model-routes.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withCurrentReadAuthority } from "../../shared/current-read-authority.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import { prepareChatAccountSelection } from "./chat-account-selection.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { createModelsListProviderFilter, listDecisionModels } from "./models-list-capabilities.js";
import {
  buildPublicModelProjection,
  projectModelServiceTiers,
  projectProviderCatalogOutcomes,
} from "./models-list-public-projection.js";
import { resolveDefaultModelsPreview } from "./models-list-result.default-models.js";
import {
  resolveModelsListOwner,
  type BuildModelsListResultParams,
  type ModelsListOwner,
} from "./models-list-result.owner.js";
import { prepareModelPickerRuntimeChoices } from "./models-list-runtime-choices.js";

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
export async function prepareModelsListResult(
  params: BuildModelsListResultParams,
): Promise<PreparedModelsListResult> {
  const owner = await resolveModelsListOwner(params);
  if (!owner) {
    return { read: () => ({ models: [] }), isCurrent: () => true };
  }
  // A prepared owner's registry can differ from the caller's (standalone CLI, workspace
  // generations); preparation resolves plugin facts from the owner. Reads stay pure
  // projections of those prepared facts.
  return withPluginRuntimeRegistryScope(owner.preparedPluginRegistry, () =>
    prepareOwnedModelsListResult(owner),
  );
}

async function prepareOwnedModelsListResult({
  params,
  scope,
  publicationScope,
  draft,
  authority,
  sessionEntry,
  useRequesterDefaults,
  currentConfig,
  publishedOwner,
  requestConfig,
  profiles,
  view,
  refresh,
  usedPreloadedCatalog,
  ownerSnapshot,
  snapshot,
  sourceOwner,
  cfg,
  agentId,
  workspaceDir,
  preparedProjectionOwner,
  metadataSnapshot,
  preparedAuthStore,
  preparedPluginRegistry,
}: ModelsListOwner): Promise<PreparedModelsListResult> {
  const preparedOwnerIsCurrent = preparedProjectionOwner?.isCurrent;
  // Native readiness belongs to the prepared generation, even across config publication.
  const isCurrent = () =>
    currentConfig() === requestConfig &&
    preparedOwnerIsCurrent?.() === true &&
    publicationScope?.isCurrent?.() !== false;
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
  const decisionOwner = () => ({
    cfg,
    agentId,
    metadataSnapshot,
    preparedAuthStore,
    accountCatalog: preparedProjectionOwner?.accountCatalog,
    preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations,
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
  if (view !== "provider-config") {
    await projector.prepareSelectedAccountCatalog(
      () => {
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
  await withCurrentReadAuthority(authority, () => {});
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
  draft?.assertCurrent();
  const defaultModels =
    (params.params.includeDefaultModels ??
    (view === "configured" && !params.params.sessionKey && !params.params.authProfileId))
      ? await resolveDefaultModelsPreview({
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
        })
      : undefined;
  draft?.assertCurrent();
  const outcomeProjection = {
    ...(defaultModels ? { defaultModels } : {}),
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
    const pendingProviders = projector.snapshot.pendingProviders?.filter(
      (provider) =>
        (!providerFilter || normalizeProvider(provider) === providerFilter) &&
        (view === "all" ||
          view === "provider-config" ||
          visibilityPolicy.allowAny ||
          [...visibilityPolicy.allowedKeys].some((key) => key.startsWith(`${provider}/`))),
    );
    return {
      ...(pendingProviders?.length ? { pendingProviders } : {}),
      ...outcomeProjection,
      ...(snapshot.refreshFailed ? { refreshFailed: true } : {}),
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
  const configuredEntriesByKey = resolveConfiguredModelEntries({
    cfg,
    agentId,
    defaultModel,
    canonicalizeRef: (ref) => ({
      ...ref,
      model:
        resolveProviderModelCatalogId({ provider: ref.provider, modelId: ref.model }) ?? ref.model,
    }),
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  }).byKey;
  const createPublicProjector = (
    decisions: ReturnType<typeof createModelCatalogDecisions>,
    modelCatalog: ModelCatalogEntry[],
  ) => {
    const projectionSnapshot = decisions.snapshot;
    const accountCatalog = preparedProjectionOwner?.accountCatalog;
    const includeDetails = params.params.includeDetails;
    const preserveUnknownAvailability = view === "provider-config" || includeDetails;
    const projectionIsCurrent =
      view === "provider-config" ? isCurrent : () => isCurrent() && decisions.isCurrent();
    const fastMode = createModelSpeedPolicyResolver({
      cfg,
      agentId,
      catalog: modelCatalog,
      metadataSnapshot,
      pluginRegistry: preparedPluginRegistry,
    });
    const catalogResolver = createThinkingCatalogResolver(catalog);
    // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
    const prepared = new WeakMap<ModelCatalogEntry, Map<string, ModelChoice>>();
    return (
      entry: ModelCatalogEntry,
      evaluation: ModelAuthAvailabilityEvaluation,
      runtimeChoice?: string,
    ): ModelChoice => {
      const runtimeKey = runtimeChoice ?? "";
      let preparedEntry = prepared.get(entry)?.get(runtimeKey);
      if (!preparedEntry) {
        const configuredEntry = configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
        const alias = configuredEntry?.aliases.at(-1);
        const publicEntry = configuredEntry?.aliasDisabled
          ? Object.assign({}, entry, { alias: undefined })
          : alias && alias !== entry.alias
            ? Object.assign({}, entry, { alias })
            : entry;
        const capabilityProvider = capableProviders?.resolveProvider(entry.provider);
        const selectedRuntime = runtimeChoice
          ? { id: runtimeChoice, source: "model" as const }
          : resolveCatalogDecisionRuntime({
              cfg,
              agentId,
              entry,
              evaluation,
              pluginRegistry: preparedPluginRegistry,
            });
        const agentRuntime = selectedRuntime
          ? preparedPluginRegistry
            ? withPluginRuntimeRegistryScope(preparedPluginRegistry, () =>
                projectWorkerPlacementAgentRuntime(selectedRuntime),
              )
            : projectWorkerPlacementAgentRuntime(selectedRuntime)
          : undefined;
        const thinkingProfile =
          typeof publicEntry.reasoning !== "boolean"
            ? undefined
            : resolveGatewayModelThinkingProfile({
                cfg,
                agentId,
                provider: entry.provider,
                model: entry.id,
                agentRuntime: selectedRuntime?.id ?? "openclaw",
                modelCatalog: runtimeChoice ? [entry] : catalog,
                catalogResolver: runtimeChoice
                  ? createThinkingCatalogResolver([entry])
                  : catalogResolver,
                configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
                thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
              });
        const fastModeState = resolveFastModeState({
          cfg,
          agentId,
          provider: entry.provider,
          model: entry.id,
        });
        preparedEntry = {
          ...buildPublicModelProjection(publicEntry, { includeDetails }),
          ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
          ...(agentRuntime ? { agentRuntime } : {}),
          ...thinkingProfile,
          ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
          ...(capabilityProvider && apiKeyProviders.has(capabilityProvider)
            ? {
                apiKeySupported: apiKeyProviders.get(capabilityProvider) === true,
              }
            : {}),
          ...(view === "provider-config" && entry.input?.length ? { input: entry.input } : {}),
        };
        const entries = prepared.get(entry) ?? new Map<string, ModelChoice>();
        entries.set(runtimeKey, preparedEntry);
        prepared.set(entry, entries);
      }
      // Legacy views require a boolean; inventory consumers preserve unknown state.
      const projectedAvailability = preserveUnknownAvailability
        ? evaluation.availability
        : (evaluation.availability ?? false);
      const speedPolicy = fastMode(entry, evaluation, preparedEntry.agentRuntime?.id);
      const supportsFastMode = speedPolicy.supportsFastMode;
      const serviceTiers = projectModelServiceTiers({
        config: cfg,
        agentId,
        pluginRegistry: preparedPluginRegistry,
        snapshot: projectionSnapshot,
        entry,
        evaluation,
        runtimeId: preparedEntry.agentRuntime?.id ?? "openclaw",
        modelServiceTiers: speedPolicy.serviceTiers,
        isCurrent: projectionIsCurrent,
      });
      const credential = evaluation.selectedCredential;
      const route = evaluation.selectedRoute;
      const serviceTierObservation =
        projectionIsCurrent() &&
        evaluation.availability === true &&
        speedPolicy.supportsServiceTierRecovery &&
        credential &&
        credential.source !== "harness" &&
        route
          ? accountCatalog?.readServiceTierObservation({
              identityKey: credential.identityKey,
              modelId: entry.id,
              runtimeId: preparedEntry.agentRuntime?.id ?? "openclaw",
              api: route.api,
              baseUrl: route.baseUrl,
            })
          : undefined;
      return Object.assign(
        {},
        preparedEntry,
        manualSelectionAllowed
          ? {
              manualSelectionAllowed: manualSelectionAllowed({
                provider: entry.provider,
                model: entry.id,
              }),
            }
          : {},
        supportsFastMode === undefined ? {} : { supportsFastMode },
        speedPolicy.supportsServiceTierRecovery === true
          ? { supportsServiceTierRecovery: true }
          : {},
        serviceTiers === undefined ? {} : { serviceTiers },
        serviceTierObservation ? { serviceTierObservation } : {},
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
      ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
    });
    const inventory = await inventoryProjector.projectCatalog(authority);
    const entries = await withCurrentReadAuthority(authority, () =>
      inventory.map((entry) => ({
        entry,
        host: inventoryProjector.evaluateEntry(entry),
      })),
    );
    const projectPublic = createPublicProjector(inventoryProjector, inventory);
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
  const { evaluateEntry } = projector;
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const runtimeChoiceReaders = new Map<string, () => ModelRuntimeChoice[]>();
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
  const projectPublic = createPublicProjector(projector, catalog);
  const readCatalog = await withCurrentReadAuthority(authority, () =>
    prepareLogicalVisibleModelCatalog({
      cfg,
      isCurrent: () => isCurrent() && projector.isCurrent(),
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
      prepareEntry: (entry, variants) => {
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
        const preparedHost = evaluateEntry(entry, variants, baseRuntime);
        // Picker alternatives never change the configured row when a session selects a sibling.
        const host = baseRuntime
          ? { ...preparedHost, requestedRuntimeId: undefined }
          : preparedHost;
        if (requestedRuntimes?.length) {
          runtimeChoiceReaders.set(
            key,
            prepareModelPickerRuntimeChoices({
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
          evaluations.set(key, evaluation);
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
    }),
  );

  return {
    isCurrent: () => isCurrent() && projector.isCurrent(),
    read: () => {
      const currentCatalog = readCatalog();
      const keyOf = createModelCatalogIdentityKeyResolver();
      return {
        models: omitCliRuntimeAliasTwins(
          currentCatalog.filter(matchesProvider).map((entry) => {
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
            return { row: projected, twin: twinRoutes.get(key) };
          }),
          selectionPolicies,
        ),
        ...readOutcomeProjection(),
      };
    },
  };
}
