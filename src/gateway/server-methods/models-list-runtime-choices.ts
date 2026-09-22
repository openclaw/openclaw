import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelRuntimeChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
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
import { openAIModelCatalogRoutePolicy } from "../../agents/openai-model-routes.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../../agents/session-runtime-compat.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CatalogDecisions = ReturnType<typeof createModelCatalogDecisions>;

/** Captures alternative runtime metadata while readiness stays with the prepared catalog owner. */
export async function prepareModelPickerRuntimeChoices(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
  variants: readonly ModelCatalogEntry[];
  requestedRuntimes: readonly string[];
  baseEvaluation: ModelAuthAvailabilityEvaluation;
  decisions: Pick<CatalogDecisions, "runtimeChoices" | "evaluateEntry" | "pluginRegistry">;
  evaluateNative: CatalogDecisions["evaluateNative"];
  projectPublic: (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId: string,
  ) => ModelChoice;
}): Promise<() => ModelRuntimeChoice[]> {
  const {
    cfg,
    agentId,
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
    agentId,
    entry,
    evaluation: baseEvaluation,
    pluginRegistry: decisions.pluginRegistry,
  });
  const availableRuntimes = await decisions.runtimeChoices(entry, variants);
  const alternatives = await Promise.all(
    requestedRuntimes
      .filter((runtimeId) => runtimeId !== (selected?.id ?? "openclaw"))
      .map(async (runtimeId) => {
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
        const runtimeHost = await decisions.evaluateEntry(runtimeEntry, variants, runtimeId);
        const runtimeRegistered =
          runtimeId === "openclaw" ||
          decisions.pluginRegistry?.agentHarnesses.some(
            ({ harness }) => harness.id === runtimeId,
          ) ||
          listCliRuntimeModelBackendBindings().some(
            (binding) =>
              binding.runtime === runtimeId &&
              normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
          );
        return () => {
          const evaluation = evaluateNative(runtimeEntry, runtimeHost, runtimeId);
          const projected = runtimeView.readProjection(
            runtimeEntry,
            resolveLogicalModelCatalogEntryState({
              evaluation,
              routePolicy: openAIModelCatalogRoutePolicy,
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
      }),
  );
  return () => alternatives.map((read) => read());
}
