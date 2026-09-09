// Resolves public model catalogs without exposing runtime-only provider params.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import { createModelCatalogView } from "../../agents/model-catalog-view.js";
import {
  resolveLogicalModelCatalogEntryState,
  prepareLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createModelFastModeResolver } from "../../agents/model-fast-mode.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { dedupeModelCatalogEntries } from "../../agents/model-selection-shared.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import {
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
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfig, getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderModelCatalogId } from "../../plugins/provider-model-routes.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { resolveChatAccountSelection } from "./chat-account-selection.js";
import type { ChatMetadataReadParams, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";
import { resolveSessionCatalogProfiles } from "./chat-metadata-session-projection.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import {
  createModelsListAuthProjection,
  type ModelsListAuthProjectionParams,
} from "./models-list-auth-resolver.js";
import {
  listConfiguredRuntimeDiscoveryProviderIds,
  resolveProviderConfigInventoryEntries,
} from "./models-list-configured-static.js";
import { prepareModelsListHarnessCatalog } from "./models-list-harness-catalog.js";
import {
  buildPublicModelProjection,
  projectProviderCatalogOutcomes,
  resolveModelChoiceAgentRuntime,
} from "./models-list-public-projection.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListEntryWithCapabilities = ModelChoice;
type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
type PreparedModelsListResult = {
  read: () => ModelsListResult;
  isCurrent: () => boolean;
};

function resolveModelsListView(params: Record<string, unknown>): ModelCatalogBrowseView {
  const view = params.view;
  return view === "configured" || view === "provider-config" || view === "all" ? view : "default";
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: ModelsListAuthProjectionParams) {
  const authProjection = createModelsListAuthProjection(params);
  const { evaluateEntry, evaluateNative, snapshot } = authProjection;
  const view = createModelCatalogView({
    cfg: params.cfg,
    catalog: snapshot.entries,
    routeVariants: snapshot.routeVariants.length > 0 ? snapshot.routeVariants : snapshot.entries,
  });
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    ...authProjection,
    projectCatalog: () =>
      (projectedCatalog ??= Promise.all(
        view.logicalEntries.map(async (entry) => {
          const routeVariants = view.variantsOf(entry) ?? [entry];
          const evaluation = evaluateNative(entry, await evaluateEntry(entry, routeVariants));
          return view.project(entry, evaluation).runtimeEntry;
        }),
      )),
  };
}

function createPublicModelsListProjector(params: {
  thinkingCatalog: ModelCatalogEntry[];
  fastMode: ReturnType<typeof createModelFastModeResolver>;
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  includeInput?: boolean;
  includeDetails?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}) {
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, ModelsListEntryWithCapabilities>();
  return (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
  ): ModelsListEntryWithCapabilities => {
    let preparedEntry = prepared.get(entry);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
      const alias = configuredEntry?.aliases.at(-1);
      const publicEntry = configuredEntry?.aliasDisabled
        ? Object.assign({}, entry, { alias: undefined })
        : alias && alias !== entry.alias
          ? Object.assign({}, entry, { alias })
          : entry;
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const agentRuntime = resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      });
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              modelCatalog: params.thinkingCatalog,
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
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
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
      prepared.set(entry, preparedEntry);
    }
    // Legacy views require a boolean; inventory consumers preserve unknown state.
    const projectedAvailability = params.preserveUnknownAvailability
      ? evaluation.availability
      : (evaluation.availability ?? false);
    const supportsFastMode = params.fastMode(entry, evaluation, preparedEntry.agentRuntime?.id);
    return Object.assign(
      {},
      preparedEntry,
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

function apiKeyProviderCapabilities(params: {
  cfg: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const { capabilities, resolveProvider } = resolveModelProviderCapabilities({
    config: params.cfg,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
  return {
    providers: new Map(
      capabilities.map(({ provider, apiKeySupported }) => [provider, apiKeySupported]),
    ),
    resolveProvider,
  };
}

type ModelsListCatalogSource =
  | { kind: "gateway"; context: GatewayRequestContext }
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
  const profiles = resolveSessionCatalogProfiles(sessionEntry);
  const useRequesterDefaults = !scope?.sessionKey && !scope?.sessionEntry;
  draft?.assertCurrent();
  const currentConfig =
    source.kind === "gateway" ? source.context.getRuntimeConfig : getRuntimeConfig;
  const publishedOwner = source.kind === "published" ? source.owner : undefined;
  const requestConfig = currentConfig();
  const initialConfig = publishedOwner?.config ?? requestConfig;
  const initialAgentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(initialConfig));
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
  let snapshot =
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
  const isCurrent = () => currentConfig() === requestConfig && preparedOwnerIsCurrent?.() === true;
  if (!metadataSnapshot || !preparedAuthStore) {
    throw new Error("Gateway model catalog owner omitted prepared metadata or auth state");
  }
  const preparedCatalog = await prepareModelsListHarnessCatalog({
    cfg,
    agentId,
    agentDir: sourceOwner?.agentDir,
    workspaceDir,
    snapshot,
    view,
    metadataSnapshot,
    pluginRegistry: preparedPluginRegistry,
    isCurrent,
    observationConfig: preparedProjectionOwner?.observationConfig,
    allowHarnessDiscovery: refresh && params.preloadedOnly !== true,
    ...(source.kind === "gateway"
      ? {
          onError: (error: unknown) =>
            source.context.logGateway.debug(
              `models.list continuing without harness catalog: ${String(error)}`,
            ),
        }
      : {}),
  });
  snapshot = preparedCatalog.snapshot;
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
  const evaluateNative: typeof projector.evaluateNative = (entry, host) => {
    const native = projector.evaluateNative(entry, host);
    return native !== host && currentConfig() !== requestConfig
      ? { ...native, availability: false }
      : native;
  };
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(metadataSnapshot, cfg);
  const providerFilter = params.params.provider
    ? normalizeProvider(params.params.provider)
    : undefined;
  if (providerFilter) {
    const knownProviders = new Set(
      [
        ...metadataSnapshot.owners.providers.keys(),
        ...metadataSnapshot.owners.modelCatalogProviders.keys(),
        ...Object.keys(cfg.models?.providers ?? {}),
        ...catalog.map((entry) => entry.provider),
      ].map(normalizeProvider),
    );
    if (!knownProviders.has(providerFilter)) {
      throw new Error(
        "Unknown model catalog provider. Use a provider id from the installed plugins or configured providers.",
      );
    }
  }
  const matchesProvider = (entry: ModelCatalogEntry) =>
    !providerFilter || normalizeProvider(entry.provider) === providerFilter;
  const { routeVariants, providerOutcomes } = projector.snapshot;
  const publicProviderOutcomes = projectProviderCatalogOutcomes(providerOutcomes);
  draft?.assertCurrent();
  const outcomeProjection = {
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
  if (view === "provider-config") {
    const sourceConfig = getRuntimeConfigSourceSnapshot() ?? cfg;
    const authoredEntries = buildProviderConfigModelCatalogForBrowse({
      cfg: sourceConfig,
      workspaceDir,
    });
    const inventorySnapshot = {
      entries: resolveProviderConfigInventoryEntries({
        authoredEntries,
        canonicalEntries: catalog,
        discoveryOnlyProviderIds: listConfiguredRuntimeDiscoveryProviderIds(
          sourceConfig,
          metadataSnapshot,
        ),
      }),
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
      includeInput: true,
      includeDetails: params.params.includeDetails,
      preserveUnknownAvailability: true,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    });
    return {
      isCurrent: () => isCurrent() && inventoryProjector.isCurrent(),
      read: () => ({
        models: entries
          .filter(({ entry }) => matchesProvider(entry))
          .map(({ entry, host }) => projectPublic(entry, evaluateNative(entry, host))),
        ...outcomeProjection,
      }),
    };
  }
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  });
  const { evaluateEntry } = projector;
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const readCatalog = await prepareLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    workspaceDir,
    view,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants,
    prepareEntry: async (entry, variants) => {
      const host = await evaluateEntry(entry, variants);
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
  const projectPublic = createPublicModelsListProjector({
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
    includeDetails: params.params.includeDetails,
    preserveUnknownAvailability: params.params.includeDetails,
    ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
  });
  return {
    isCurrent: () => isCurrent() && projector.isCurrent(),
    read: () => ({
      models: readCatalog()
        .filter(matchesProvider)
        .map((entry) => {
          const evaluation = evaluations.get(resolveModelCatalogIdentityKey(entry));
          if (!evaluation) {
            throw new Error("Model catalog publication omitted prepared auth evaluation");
          }
          return projectPublic(entry, evaluation);
        }),
      ...outcomeProjection,
    }),
  };
}
