import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelProviderConfig } from "../config/types.js";
import { copyRecordEntries } from "../shared/safe-record.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";

function addApiKeyToProvider(
  provider: ModelProviderConfig,
  apiKey: string,
): (ModelProviderConfig & { apiKey: string }) | undefined {
  try {
    return { ...provider, apiKey };
  } catch {
    return undefined;
  }
}

export function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  // Template ids are tried in caller priority order while provider ids are
  // normalized so catalog augmentation survives provider alias casing changes.
  return params.templateIds
    .map((templateId) =>
      params.entries.find(
        (entry) =>
          normalizeProviderId(entry.provider) === normalizeProviderId(params.providerId) &&
          normalizeLowercaseStringOrEmpty(entry.id) === normalizeLowercaseStringOrEmpty(templateId),
      ),
    )
    .find((entry) => entry !== undefined);
}

/**
 * Builds a single-provider catalog entry from the configured provider API key.
 *
 * Returns null when credentials are absent so provider catalogs can be composed
 * without treating an unauthenticated provider as a hard failure.
 */
export async function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult> {
  const providerId = normalizeProviderId(params.providerId);
  const apiKey = params.ctx.resolveProviderApiKey(providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitProvider =
    params.allowExplicitBaseUrl && params.ctx.config.models?.providers
      ? Object.entries(params.ctx.config.models.providers).find(
          ([configuredProviderId]) => normalizeProviderId(configuredProviderId) === providerId,
        )?.[1]
      : undefined;
  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";

  // Explicit base URLs are opt-in because most provider catalogs should stay on
  // their manifest defaults; local OpenAI-compatible providers need the override.
  return {
    provider: {
      ...(await params.buildProvider()),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    },
  };
}

/**
 * Builds a paired-provider catalog where multiple provider configs share one key.
 *
 * Providers that cannot be cloned with the API key are skipped so one malformed
 * provider config does not drop the whole paired catalog.
 */
export async function buildPairedProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProviders: () =>
    | Record<string, ModelProviderConfig>
    | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult> {
  const apiKey = params.ctx.resolveProviderApiKey(normalizeProviderId(params.providerId)).apiKey;
  if (!apiKey) {
    return null;
  }

  const providers = await params.buildProviders();
  return {
    providers: Object.fromEntries(
      copyRecordEntries<ModelProviderConfig>(providers).flatMap(([id, provider]) => {
        const providerWithApiKey = addApiKeyToProvider(provider, apiKey);
        return providerWithApiKey ? [[id, providerWithApiKey]] : [];
      }),
    ),
  };
}
