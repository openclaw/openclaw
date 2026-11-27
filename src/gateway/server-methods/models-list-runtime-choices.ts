import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelRuntimeChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import type { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { projectModelCatalogAccessPrograms } from "../../agents/model-catalog-access-programs.js";
import {
  type createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../../agents/model-catalog-decisions.js";
import type { createConfiguredModelCatalogOverridesResolver } from "../../agents/model-catalog-route.js";
import {
  createModelCatalogView,
  selectModelCatalogRuntimeEntry,
} from "../../agents/model-catalog-view.js";
import { resolveLogicalModelCatalogEntryState } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createModelSpeedPolicyResolver } from "../../agents/model-fast-mode.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import type { AgentRuntimePolicyScope } from "../../agents/model-runtime-policy.js";
import type { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../../agents/session-runtime-compat.js";
import { createThinkingCatalogResolver } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { readDeclaredProviderNames } from "../provider-presentation.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import type { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import type { BuildModelsListResultParams } from "./models-list-context.js";
import {
  buildPublicModelProjection,
  projectModelServiceTiers,
  retainModelChoiceAccountPin,
} from "./models-list-public-projection.js";

type CatalogDecisions = ReturnType<typeof createModelCatalogDecisions>;

type PickerRuntimeProjectionInput = {
  cfg: OpenClawConfig;
  entry: ModelCatalogEntry;
  variants: readonly ModelCatalogEntry[];
  decisions: Pick<
    CatalogDecisions,
    "runtimeChoices" | "evaluateEntry" | "pluginRegistry" | "resolveOpenAIProviderRoutes"
  > &
    Partial<
      Pick<
        CatalogDecisions,
        "prepareRuntimeChoices" | "prepareNativePolicy" | "resolveDecisionRuntime"
      >
    >;
  resolveOverrides?: ReturnType<typeof createConfiguredModelCatalogOverridesResolver>;
  warmPublicProjection?: (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId: string,
  ) => void;
  evaluateNative: CatalogDecisions["evaluateNative"];
  projectPublic: (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId: string,
  ) => ModelChoice;
};

/** Captures alternative runtime metadata while the prepared catalog owner tracks readiness. */
function prepareModelPickerRuntimeChoices(
  params: PickerRuntimeProjectionInput &
    AgentRuntimePolicyScope & {
      requestedRuntimes: readonly string[];
      baseEvaluation: ModelAuthAvailabilityEvaluation;
    },
): (excludedRuntimeId?: string) => ModelRuntimeChoice[] {
  const {
    cfg,
    entry,
    variants,
    requestedRuntimes,
    baseEvaluation,
    decisions,
    evaluateNative,
    projectPublic,
    agentScope,
    agentId,
  } = params;
  const scope = agentScope ? { agentScope } : { agentId };
  const selected = decisions.resolveDecisionRuntime
    ? decisions.resolveDecisionRuntime(entry, baseEvaluation, scope)
    : resolveCatalogDecisionRuntime({
        cfg,
        ...scope,
        entry,
        evaluation: baseEvaluation,
        pluginRegistry: decisions.pluginRegistry,
        resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
      });
  const alternatives = requestedRuntimes.map((runtimeId) => {
    const selectable =
      resolveCompatibleAgentRuntimeForProvider({
        provider: entry.provider,
        runtime: runtimeId,
        cfg,
      }) === runtimeId;
    const { entry: runtimeEntry, variants: runtimeVariants } = selectModelCatalogRuntimeEntry({
      entry,
      routeVariants: variants,
      runtimeId,
    });
    const runtimeView = createModelCatalogView({
      cfg,
      catalog: [runtimeEntry],
      routeVariants: runtimeVariants,
      resolveOverrides: params.resolveOverrides,
    });
    // Authorization keeps every observed route; metadata donors stay runtime-specific.
    const runtimeHost = decisions.evaluateEntry(runtimeEntry, variants, runtimeId);
    decisions.prepareNativePolicy?.(runtimeEntry, runtimeHost, runtimeId);
    if (params.warmPublicProjection) {
      const initialProjected = runtimeView.readProjection(
        runtimeEntry,
        resolveLogicalModelCatalogEntryState({ evaluation: runtimeHost }).routeProjection,
      ).runtimeEntry;
      params.warmPublicProjection(initialProjected, runtimeHost, runtimeId);
    }
    const runtimeRegistered =
      runtimeId === "openclaw" ||
      decisions.pluginRegistry?.agentHarnesses.some(({ harness }) => harness.id === runtimeId) ||
      listCliRuntimeModelBackendBindings().some(
        (binding) =>
          binding.runtime === runtimeId &&
          normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
      );
    const read = (availableRuntimes: readonly string[] | undefined) => {
      const evaluation = evaluateNative(runtimeEntry, runtimeHost, runtimeId);
      const projected = runtimeView.readProjection(
        runtimeEntry,
        resolveLogicalModelCatalogEntryState({
          evaluation,
        }).routeProjection,
      ).runtimeEntry;
      const { agentRuntime, ...capabilities }: Partial<ModelChoice> = projectPublic(
        projected,
        evaluation,
        runtimeId,
      );
      delete capabilities.id;
      delete capabilities.name;
      delete capabilities.provider;
      delete capabilities.alias;
      delete capabilities.tags;
      delete capabilities.apiKeySupported;
      delete capabilities.runtimeChoices;
      const runtime = { id: runtimeId, source: "model" as const, ...agentRuntime };
      if (!selectable || availableRuntimes?.includes(runtimeId) !== true) {
        const compatibleRuntimes = evaluation.selectedRoute?.runtimePolicy?.compatibleIds;
        const unavailableReason =
          !selectable ||
          (decisions.pluginRegistry !== undefined && !runtimeRegistered) ||
          (compatibleRuntimes !== undefined && !compatibleRuntimes.includes(runtimeId))
            ? "unsupported-runtime"
            : evaluation.unavailableReason;
        return {
          agentRuntime: runtime,
          available: false,
          ...(unavailableReason ? { unavailableReason } : {}),
          ...(evaluation.unavailableUntil === undefined
            ? {}
            : { unavailableUntil: evaluation.unavailableUntil }),
        } satisfies ModelRuntimeChoice;
      }
      return {
        ...capabilities,
        agentRuntime: runtime,
        available: evaluation.availability === true,
      } satisfies ModelRuntimeChoice;
    };
    return { runtimeId, read };
  });
  return (excludedRuntimeId = selected?.id ?? "openclaw") => {
    const availableRuntimes = decisions.runtimeChoices(entry, variants);
    return alternatives
      .filter((item) => item.runtimeId !== excludedRuntimeId)
      .map((item) => item.read(availableRuntimes));
  };
}

/** Editable defaults own the harness; the requesting agent's catalog owns readiness. */
function prepareDefaultModelPickerRuntimes(
  params: PickerRuntimeProjectionInput & {
    requestedRuntimes: readonly string[];
    scopedHost: ModelAuthAvailabilityEvaluation;
    scopedRuntime: string | undefined;
    matchingRuntime: string | undefined;
  },
): ((row: ModelChoice) => ModelChoice["defaultModelRuntimes"]) | undefined {
  const { cfg, entry, variants, decisions, evaluateNative } = params;
  const agentScope = { kind: "defaults" as const };
  const runtime = resolveAgentHarnessPolicy({
    config: cfg,
    agentScope,
    provider: entry.provider,
    modelId: entry.id,
    modelApi: entry.api,
    modelBaseUrl: entry.baseUrl,
    resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
  }).runtime;
  if (!params.requestedRuntimes.length && runtime === params.matchingRuntime) {
    // The ordinary row already evaluates this policy with the same credentials.
    return undefined;
  }
  const host =
    runtime === params.scopedRuntime
      ? params.scopedHost
      : decisions.evaluateEntry(entry, variants, runtime);
  const baseEvaluation = evaluateNative(entry, { ...host, requestedRuntimeId: undefined });
  const resolveBase = () =>
    (decisions.resolveDecisionRuntime
      ? decisions.resolveDecisionRuntime(entry, baseEvaluation, { agentScope })
      : resolveCatalogDecisionRuntime({
          cfg,
          agentScope,
          entry,
          evaluation: baseEvaluation,
          pluginRegistry: decisions.pluginRegistry,
          resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
        })) ?? { id: "openclaw", source: "implicit" as const };
  const initialBase = resolveBase();
  const initialBaseHost =
    initialBase.id === runtime ? host : decisions.evaluateEntry(entry, variants, initialBase.id);
  const alternatives = params.requestedRuntimes.length
    ? prepareModelPickerRuntimeChoices({ ...params, agentScope, baseEvaluation })
    : undefined;
  return (row) => {
    const base = resolveBase();
    const baseHost =
      base.id === runtime
        ? host
        : base.id === initialBase.id
          ? initialBaseHost
          : decisions.evaluateEntry(entry, variants, base.id);
    const available = evaluateNative(entry, baseHost, base.id).availability === true;
    if (
      !alternatives &&
      base.id === (row.agentRuntime?.id ?? "openclaw") &&
      available === row.available
    ) {
      return undefined;
    }
    const choices = alternatives?.(base.id);
    return {
      base: { agentRuntime: base, available },
      alternatives:
        choices?.map(({ agentRuntime, available: ready, manualSelectionAllowed }) => ({
          agentRuntime,
          available: ready,
          manualSelectionAllowed,
        })) ?? [],
    };
  };
}

export function prepareModelPickerRuntimeProjection(
  params: PickerRuntimeProjectionInput & {
    agentId: string;
    requestedRuntimes?: readonly string[];
    defaultRuntimes?: readonly string[];
    previewDefaultBase: boolean;
  },
): {
  host: ModelAuthAvailabilityEvaluation;
  project?: (model: ModelChoice) => void;
} {
  const {
    cfg,
    agentId,
    entry,
    variants,
    requestedRuntimes,
    defaultRuntimes,
    decisions,
    evaluateNative,
  } = params;
  const scopedRuntime =
    requestedRuntimes?.length || params.previewDefaultBase
      ? resolveAgentHarnessPolicy({
          config: cfg,
          agentId,
          provider: entry.provider,
          modelId: entry.id,
          modelApi: entry.api,
          modelBaseUrl: entry.baseUrl,
          resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
        }).runtime
      : undefined;
  const baseRuntime = requestedRuntimes?.length ? scopedRuntime : undefined;
  const preparedHost = decisions.evaluateEntry(entry, variants, baseRuntime);
  // Picker alternatives never change the configured row when a session selects a sibling.
  const host = baseRuntime ? { ...preparedHost, requestedRuntimeId: undefined } : preparedHost;
  const readScoped = requestedRuntimes?.length
    ? prepareModelPickerRuntimeChoices({
        ...params,
        requestedRuntimes,
        baseEvaluation: evaluateNative(entry, host),
      })
    : undefined;
  const readDefaults =
    defaultRuntimes?.length || params.previewDefaultBase
      ? prepareDefaultModelPickerRuntimes({
          cfg,
          entry,
          variants,
          decisions,
          evaluateNative,
          projectPublic: params.projectPublic,
          resolveOverrides: params.resolveOverrides,
          warmPublicProjection: params.warmPublicProjection,
          requestedRuntimes: defaultRuntimes ?? [],
          scopedHost: preparedHost,
          scopedRuntime: baseRuntime,
          matchingRuntime: preparedHost.requestedRuntimeId ?? scopedRuntime,
        })
      : undefined;
  if (requestedRuntimes?.length || defaultRuntimes?.length) {
    decisions.prepareRuntimeChoices?.(entry, variants);
  }
  return {
    host,
    ...(readScoped || readDefaults
      ? {
          project: (model: ModelChoice) => {
            const choices = readScoped?.(model.agentRuntime?.id ?? "openclaw");
            if (choices?.length) {
              model.runtimeChoices = choices;
            }
            const defaults = readDefaults?.(model);
            if (defaults) {
              model.defaultModelRuntimes = defaults;
            }
          },
        }
      : {}),
  };
}

type StatedRuntimeModelChoice = ModelChoice & {
  agentRuntime: NonNullable<ModelChoice["agentRuntime"]>;
};

/** Prepares public row fields and overlays current availability and account observations. */
export function createModelsListPublicProjector(params: {
  cfg: OpenClawConfig;
  agentId: string;
  decisions: CatalogDecisions;
  modelCatalog: ModelCatalogEntry[];
  catalog: ModelCatalogEntry[];
  accountCatalog?: CatalogDecisions["accountCatalog"];
  includeDetails?: boolean;
  view: NonNullable<BuildModelsListResultParams["params"]["view"]>;
  isCurrent: () => boolean;
  metadataSnapshot: CatalogDecisions["metadataSnapshot"];
  preparedPluginRegistry?: CatalogDecisions["pluginRegistry"];
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  capableProviders?: ReturnType<typeof resolveModelProviderCapabilities>;
  apiKeyProviders: ReadonlyMap<string, boolean>;
  manualSelectionAllowed?: ReturnType<typeof createModelVisibilityPolicy>["allows"];
}) {
  const {
    cfg,
    agentId,
    decisions,
    modelCatalog,
    catalog,
    accountCatalog,
    includeDetails,
    view,
    isCurrent,
    metadataSnapshot,
    preparedPluginRegistry,
    configuredEntriesByKey,
    capableProviders,
    apiKeyProviders,
    manualSelectionAllowed,
  } = params;
  const projectionSnapshot = decisions.snapshot;
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
  const declaredNames = readDeclaredProviderNames(preparedPluginRegistry);
  const displayFields = new Map<string, ReturnType<typeof prepareDisplayFields>>();
  const agentRuntimes = new Map<string, StatedRuntimeModelChoice["agentRuntime"]>();
  const mainThinkingProfiles = new Map<
    string,
    ReturnType<typeof resolveGatewayModelThinkingProfile>
  >();
  const prepared = new WeakMap<ModelCatalogEntry, Map<string, StatedRuntimeModelChoice>>();

  function prepareDisplayFields(entry: ModelCatalogEntry) {
    const configuredEntry = configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
    const providerName = declaredNames.get(normalizeProviderId(entry.provider));
    const capabilityProvider = capableProviders?.resolveProvider(entry.provider);
    const fastModeState = resolveFastModeState({
      cfg,
      agentId,
      provider: entry.provider,
      model: entry.id,
    });
    return {
      alias: configuredEntry?.aliases.at(-1),
      aliasDisabled: configuredEntry?.aliasDisabled,
      fields: {
        ...(providerName ? { providerName } : {}),
        ...(manualSelectionAllowed
          ? {
              manualSelectionAllowed: manualSelectionAllowed({
                provider: entry.provider,
                model: entry.id,
              }),
            }
          : {}),
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && apiKeyProviders.has(capabilityProvider)
          ? { apiKeySupported: apiKeyProviders.get(capabilityProvider) === true }
          : {}),
      },
    };
  }

  type SelectedRuntime = NonNullable<ReturnType<typeof decisions.resolveDecisionRuntime>>;
  const implicitRuntime = { id: "openclaw", source: "implicit" as const };
  const preparePublicEntry = (
    entry: ModelCatalogEntry,
    selectedRuntime: SelectedRuntime,
    runtimeChoice?: string,
  ): StatedRuntimeModelChoice => {
    const agentRuntimeKey = [selectedRuntime.id, selectedRuntime.source].join("\0");
    const runtimeKey = [runtimeChoice ?? "", agentRuntimeKey].join("\0");
    let rows = prepared.get(entry);
    const existing = rows?.get(runtimeKey);
    if (existing) {
      return existing;
    }
    const key = modelKey(entry.provider, entry.id);
    let display = displayFields.get(key);
    if (!display) {
      display = prepareDisplayFields(entry);
      displayFields.set(key, display);
    }
    const publicEntry = display.aliasDisabled
      ? { ...entry, alias: undefined }
      : display.alias && display.alias !== entry.alias
        ? { ...entry, alias: display.alias }
        : entry;
    let agentRuntime = agentRuntimes.get(agentRuntimeKey);
    if (!agentRuntime) {
      agentRuntime = preparedPluginRegistry
        ? withPluginRuntimeRegistryScope(preparedPluginRegistry, () =>
            projectWorkerPlacementAgentRuntime(selectedRuntime),
          )
        : projectWorkerPlacementAgentRuntime(selectedRuntime);
      agentRuntimes.set(agentRuntimeKey, agentRuntime);
    }

    let thinkingProfile: ReturnType<typeof resolveGatewayModelThinkingProfile> | undefined;
    if (typeof publicEntry.reasoning === "boolean") {
      const configuredReasoning = publicEntry.configuredReasoning ?? publicEntry.reasoning;
      const resolveThinking = () =>
        resolveGatewayModelThinkingProfile({
          cfg,
          agentId,
          provider: entry.provider,
          model: entry.id,
          agentRuntime: selectedRuntime.id,
          modelCatalog: runtimeChoice ? [entry] : catalog,
          catalogResolver: runtimeChoice ? createThinkingCatalogResolver([entry]) : catalogResolver,
          configuredReasoning,
          thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
        });
      if (runtimeChoice) {
        thinkingProfile = resolveThinking();
      } else {
        const thinkingKey = [
          key,
          selectedRuntime.id,
          configuredReasoning,
          publicEntry.thinkingPolicyProvider,
        ].join("\0");
        thinkingProfile = mainThinkingProfiles.get(thinkingKey);
        if (!thinkingProfile) {
          thinkingProfile = resolveThinking();
          mainThinkingProfiles.set(thinkingKey, thinkingProfile);
        }
      }
    }
    const preparedEntry = {
      ...buildPublicModelProjection(publicEntry, { includeDetails }),
      ...display.fields,
      agentRuntime,
      ...thinkingProfile,
      ...(view === "provider-config" && entry.input?.length ? { input: entry.input } : {}),
    };
    if (!rows) {
      rows = new Map();
      prepared.set(entry, rows);
    }
    rows.set(runtimeKey, preparedEntry);
    return preparedEntry;
  };
  const warmPublicProjection = (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeChoice?: string,
  ): void => {
    const selectedRuntime = runtimeChoice
      ? { id: runtimeChoice, source: "model" as const }
      : (decisions.prepareDecisionRuntime(entry, evaluation) ?? implicitRuntime);
    preparePublicEntry(entry, selectedRuntime, runtimeChoice);
  };
  const projectPublic = (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeChoice?: string,
  ): ModelChoice => {
    // Harness support can change between reads of the same physical row.
    const selectedRuntime = runtimeChoice
      ? { id: runtimeChoice, source: "model" as const }
      : (decisions.resolveDecisionRuntime(entry, evaluation) ?? implicitRuntime);
    const preparedEntry = preparePublicEntry(entry, selectedRuntime, runtimeChoice);
    const projectedAvailability =
      preserveUnknownAvailability || evaluation.runtimeAuth?.source === "native"
        ? evaluation.availability
        : (evaluation.availability ?? false);
    const runtimeId = preparedEntry.agentRuntime.id;
    const speedPolicy = fastMode(entry, evaluation, runtimeId);
    const supportsFastMode = speedPolicy.supportsFastMode;
    const serviceTiers = projectModelServiceTiers({
      config: cfg,
      agentId,
      pluginRegistry: preparedPluginRegistry,
      snapshot: projectionSnapshot,
      entry,
      evaluation,
      runtimeId,
      modelServiceTiers: speedPolicy.serviceTiers,
      isCurrent: projectionIsCurrent,
    });
    const credential = evaluation.selectedCredential;
    const route = evaluation.selectedRoute;
    const serviceTierObservations =
      projectionIsCurrent() &&
      evaluation.availability === true &&
      speedPolicy.supportsServiceTierRecovery &&
      credential &&
      credential.source !== "harness" &&
      route
        ? accountCatalog?.readServiceTierObservations({
            identityKey: credential.identityKey,
            modelId: entry.id,
            runtimeId,
            api: route.api,
            baseUrl: route.baseUrl,
          })
        : undefined;
    const choice: ModelChoice = {
      ...preparedEntry,
      ...(supportsFastMode === undefined ? {} : { supportsFastMode }),
      ...(speedPolicy.supportsServiceTierRecovery === true
        ? { supportsServiceTierRecovery: true }
        : {}),
      ...(serviceTiers === undefined ? {} : { serviceTiers }),
      ...(view === "provider-config"
        ? {}
        : projectModelCatalogAccessPrograms({
            config: cfg,
            agentId,
            snapshot: projectionSnapshot,
            entry,
            evaluation,
            runtimeId,
            isCurrent: projectionIsCurrent,
          })),
      ...(serviceTierObservations?.length
        ? {
            serviceTierObservation: serviceTierObservations.at(-1),
            serviceTierObservations: serviceTierObservations.toSorted((a, b) =>
              a.requestedTier.localeCompare(b.requestedTier),
            ),
          }
        : {}),
      ...(projectedAvailability === undefined ? {} : { available: projectedAvailability }),
      ...(projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {}),
    };
    return retainModelChoiceAccountPin(choice, decisions.hasPinnedAccount(entry));
  };
  return { projectPublic, warmPublicProjection };
}
