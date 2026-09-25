import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type {
  ModelCatalogProviderOutcome,
  ModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { isLocalBaseUrl } from "../../agents/model-catalog-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";

type ModelsListEntry = Pick<
  ModelChoice,
  | "alias"
  | "contextTokens"
  | "local"
  | "contextWindow"
  | "contextWindowDefault"
  | "contextWindows"
  | "id"
  | "input"
  | "name"
  | "provider"
  | "reasoning"
  | "tags"
> & { available?: boolean; supportsTools?: boolean };

/** Keeps concrete route, auth, cost, and provider parameters out of public model rows. */
export function buildPublicModelProjection(
  entry: ModelCatalogEntry,
  options: { includeDetails?: boolean } = {},
): ModelsListEntry {
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
