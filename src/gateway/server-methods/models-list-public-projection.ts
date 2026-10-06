import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type {
  ModelCatalogProviderOutcome,
  ModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { isLocalBaseUrl } from "../../agents/model-catalog-route.js";
import { resolveModelCatalogServiceTiers } from "../../agents/model-catalog-service-tiers.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";

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
  const contextTokens = options.includeDetails
    ? resolvePositiveSafeInteger(entry.contextTokens)
    : undefined;
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(contextTokens ? { contextTokens } : {}),
    ...(options.includeDetails && entry.baseUrl ? { local: isLocalBaseUrl(entry.baseUrl) } : {}),
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
  return outcomes?.map(({ provider, profileId, status }) => ({
    provider,
    ...(profileId ? { profileId } : {}),
    status,
  }));
}
