import { normalizeModelFamily } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type {
  ModelCatalogProviderOutcome,
  ModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { isLocalBaseUrl } from "../../agents/model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { modelMatchesProviderModelRoute } from "../../agents/provider-model-route.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { supportsOpenAIResponsesFastMode } from "../../llm/providers/openai-fast-mode.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";

/** Account observations are never model metadata donors or native-login readiness. */
function resolveModelCatalogServiceTiers(params: {
  snapshot: ModelCatalogSnapshot;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtimeId?: string;
  modelServiceTiers?: readonly string[];
  isCurrent: () => boolean;
}): string[] | undefined {
  const { snapshot, entry, evaluation, runtimeId } = params;
  const route = evaluation.selectedRoute;
  const credential = evaluation.selectedCredential;
  if (
    !params.isCurrent() ||
    evaluation.availability !== true ||
    !credential ||
    credential.source === "harness" ||
    !route ||
    !runtimeId
  ) {
    return undefined;
  }
  // API-key Responses tiers are a route contract; the ChatGPT catalog cannot describe them.
  if (
    runtimeId === "openclaw" &&
    normalizeProviderId(entry.provider) === "openai" &&
    credential.requirement === "api-key" &&
    route.authRequirement === "api-key" &&
    route.api === "openai-responses" &&
    supportsOpenAIResponsesFastMode({ provider: "openai", ...route })
  ) {
    return [...(params.modelServiceTiers ?? ["priority", "ultrafast"])];
  }
  if (
    credential.source !== "profile" ||
    route.requestTransportOverrides === "present" ||
    snapshot.refreshFailed ||
    snapshot.pendingProviders?.some(
      (provider) => normalizeProviderId(provider) === normalizeProviderId(entry.provider),
    )
  ) {
    return undefined;
  }
  const outcome = snapshot.providerOutcomes?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizeProviderId(entry.provider) &&
      candidate.profileId === credential.profileId,
  );
  if (outcome?.status !== "ready") {
    return undefined;
  }
  const observation = outcome.modelServiceTiers?.find(
    (candidate) =>
      candidate.modelId === entry.id &&
      candidate.runtimeId === runtimeId &&
      modelMatchesProviderModelRoute({
        provider: entry.provider,
        api: candidate.api,
        baseUrl: candidate.baseUrl,
        route,
      }),
  );
  return observation ? [...observation.serviceTiers] : undefined;
}

/** Harness policy can remove tiers from account/route evidence, never grant new ones. */
export function projectModelServiceTiers(
  params: Parameters<typeof resolveModelCatalogServiceTiers>[0] & {
    config: OpenClawConfig;
    agentId?: string;
    pluginRegistry?: Pick<PluginRegistry, "agentHarnesses">;
  },
): string[] | undefined {
  const serviceTiers = resolveModelCatalogServiceTiers(params);
  if (serviceTiers === undefined) {
    return undefined;
  }
  const harness = params.pluginRegistry?.agentHarnesses.find(
    (registration) => registration.harness.id === params.runtimeId,
  )?.harness;
  if (!harness?.filterModelServiceTiers) {
    return serviceTiers;
  }
  const allowedTiers = new Set(
    harness.filterModelServiceTiers({
      config: params.config,
      agentId: params.agentId,
      provider: params.entry.provider,
      modelId: params.entry.id,
      serviceTiers,
    }),
  );
  return serviceTiers.filter((tier) => allowedTiers.has(tier));
}

/** Keeps concrete route, auth, cost, and provider parameters out of public model rows. */
export function buildPublicModelProjection(
  entry: ModelCatalogEntry,
  options: { includeDetails?: boolean } = {},
): ModelChoice {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  const contextTokens = resolvePositiveSafeInteger(entry.contextTokens);
  const family = normalizeModelFamily(entry.family);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(family ? { family } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(contextTokens ? { contextTokens } : {}),
    ...(entry.baseUrl ? { local: isLocalBaseUrl(entry.baseUrl) } : {}),
    ...(options.includeDetails && entry.input?.length ? { input: entry.input } : {}),
    ...(entry.contextWindows ? { contextWindows: entry.contextWindows } : {}),
    ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
  };
}

export function projectProviderCatalogOutcomes(
  outcomes: readonly ProviderCatalogOutcome[] | undefined,
): ModelCatalogProviderOutcome[] | undefined {
  return outcomes?.map(({ provider, profileId, status, unlistedConfiguredModelIds }) => ({
    provider,
    ...(profileId ? { profileId } : {}),
    status,
    ...(status === "ready" && unlistedConfiguredModelIds?.length
      ? { unlistedConfiguredModelIds: [...unlistedConfiguredModelIds] }
      : {}),
  }));
}
