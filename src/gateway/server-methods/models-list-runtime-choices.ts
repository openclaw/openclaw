import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelRuntimeChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  resolveCatalogDecisionRuntime,
  type createModelCatalogDecisions,
} from "../../agents/model-catalog-decisions.js";
import {
  createModelCatalogView,
  selectModelCatalogRuntimeEntry,
} from "../../agents/model-catalog-view.js";
import { resolveLogicalModelCatalogEntryState } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { AgentRuntimePolicyScope } from "../../agents/model-runtime-policy.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../../agents/session-runtime-compat.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CatalogDecisions = ReturnType<typeof createModelCatalogDecisions>;

type PickerRuntimeProjectionInput = {
  cfg: OpenClawConfig;
  entry: ModelCatalogEntry;
  variants: readonly ModelCatalogEntry[];
  decisions: Pick<
    CatalogDecisions,
    "runtimeChoices" | "evaluateEntry" | "pluginRegistry" | "resolveOpenAIProviderRoutes"
  >;
  evaluateNative: CatalogDecisions["evaluateNative"];
  projectPublic: (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId: string,
  ) => ModelChoice;
};

/** Captures alternative runtime metadata while readiness stays with the prepared catalog owner. */
function prepareModelPickerRuntimeChoices(
  params: PickerRuntimeProjectionInput &
    AgentRuntimePolicyScope & {
      requestedRuntimes: readonly string[];
      baseEvaluation: ModelAuthAvailabilityEvaluation;
    },
): () => ModelRuntimeChoice[] {
  const {
    cfg,
    entry,
    variants,
    requestedRuntimes,
    baseEvaluation,
    decisions,
    evaluateNative,
    projectPublic,
  } = params;
  const selected = resolveCatalogDecisionRuntime({
    cfg,
    ...(params.agentScope ? { agentScope: params.agentScope } : { agentId: params.agentId }),
    entry,
    evaluation: baseEvaluation,
    pluginRegistry: decisions.pluginRegistry,
    resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
  });
  const alternatives = requestedRuntimes
    .filter((runtimeId) => runtimeId !== (selected?.id ?? "openclaw"))
    .map((runtimeId) => {
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
      });
      // Authorization keeps every observed route; metadata donors stay runtime-specific.
      const runtimeHost = decisions.evaluateEntry(runtimeEntry, variants, runtimeId);
      const runtimeRegistered =
        runtimeId === "openclaw" ||
        decisions.pluginRegistry?.agentHarnesses.some(({ harness }) => harness.id === runtimeId) ||
        listCliRuntimeModelBackendBindings().some(
          (binding) =>
            binding.runtime === runtimeId &&
            normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
        );
      return (availableRuntimes: readonly string[] | undefined) => {
        const evaluation = evaluateNative(runtimeEntry, runtimeHost, runtimeId);
        const projected = runtimeView.readProjection(
          runtimeEntry,
          resolveLogicalModelCatalogEntryState({
            evaluation,
          }).routeProjection,
        ).runtimeEntry;
        const {
          id: _id,
          name: _name,
          provider: _provider,
          alias: _alias,
          tags: _tags,
          apiKeySupported: _apiKeySupported,
          runtimeChoices: _runtimeChoices,
          agentRuntime,
          ...capabilities
        } = projectPublic(projected, evaluation, runtimeId);
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
    });
  return () => {
    const availableRuntimes = decisions.runtimeChoices(entry, variants);
    return alternatives.map((read) => read(availableRuntimes));
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
  const base = resolveCatalogDecisionRuntime({
    cfg,
    agentScope,
    entry,
    evaluation: baseEvaluation,
    pluginRegistry: decisions.pluginRegistry,
    resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
  }) ?? { id: "openclaw", source: "implicit" as const };
  const baseHost = base.id === runtime ? host : decisions.evaluateEntry(entry, variants, base.id);
  const alternatives = params.requestedRuntimes.length
    ? prepareModelPickerRuntimeChoices({ ...params, agentScope, baseEvaluation })
    : undefined;
  return (row) => {
    const available = evaluateNative(entry, baseHost, base.id).availability === true;
    if (
      !alternatives &&
      base.id === (row.agentRuntime?.id ?? "openclaw") &&
      available === row.available
    ) {
      return undefined;
    }
    return {
      base: { agentRuntime: base, available },
      alternatives:
        alternatives?.().map(({ agentRuntime, available: ready, manualSelectionAllowed }) => ({
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
          requestedRuntimes: defaultRuntimes ?? [],
          scopedHost: preparedHost,
          scopedRuntime: baseRuntime,
          matchingRuntime: preparedHost.requestedRuntimeId ?? scopedRuntime,
        })
      : undefined;
  return {
    host,
    ...(readScoped || readDefaults
      ? {
          project: (model: ModelChoice) => {
            const choices = readScoped?.();
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
