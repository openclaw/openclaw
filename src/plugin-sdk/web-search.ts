export { formatCliCommand } from "../cli/command-format.js";
export type { OpenClawConfig } from "../config/config.js";
export { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
export { wrapWebContent } from "../security/external-content.js";
export { normalizeSecretInput } from "../utils/normalize-secret-input.js";
export type {
  CacheEntry,
  SearchProviderContext,
  SearchProviderExecutionResult,
  SearchProviderRequest,
  SearchProviderPlugin,
  SearchProviderRuntimeMetadataResolver,
  SearchProviderSuccessResult,
} from "../plugins/types.js";
export {
  normalizeCacheKey,
  readCache,
  readResponseText,
  writeCache,
} from "../agents/tools/web-shared.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export { resolveCitationRedirectUrl } from "../agents/tools/web-search-citation-redirect.js";

export type SearchProviderLegacyUiMetadata = {
  label: string;
  hint: string;
  envKeys: readonly string[];
  placeholder: string;
  signupUrl: string;
  apiKeyConfigPath: string;
  readApiKeyValue?: (search: Record<string, unknown> | undefined) => unknown;
  writeApiKeyValue?: (search: Record<string, unknown>, value: unknown) => void;
};

export type SearchProviderFilterSupport = {
  country?: boolean;
  language?: boolean;
  freshness?: boolean;
  date?: boolean;
  domainFilter?: boolean;
};

export type SearchProviderLegacyUiMetadataParams = Omit<
  SearchProviderLegacyUiMetadata,
  "readApiKeyValue" | "writeApiKeyValue"
> & {
  provider: string;
};

const WEB_SEARCH_DOCS_URL = "https://docs.openclaw.ai/tools/web";

export function resolveSearchConfig<T>(search?: Record<string, unknown>): T {
  return search as T;
}

export function resolveSearchProviderSectionConfig<T>(
  search: Record<string, unknown> | undefined,
  provider: string,
): T {
  if (!search || typeof search !== "object") {
    return {} as T;
  }
  const scoped = search[provider];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return {} as T;
  }
  return scoped as T;
}

export function createLegacySearchProviderMetadata(
  params: SearchProviderLegacyUiMetadataParams,
): SearchProviderLegacyUiMetadata {
  return {
    label: params.label,
    hint: params.hint,
    envKeys: params.envKeys,
    placeholder: params.placeholder,
    signupUrl: params.signupUrl,
    apiKeyConfigPath: params.apiKeyConfigPath,
    resolveRuntimeMetadata: params.resolveRuntimeMetadata,
    readApiKeyValue: (search) => readSearchProviderApiKeyValue(search, params.provider),
    writeApiKeyValue: (search, value) =>
      writeSearchProviderApiKeyValue({ search, provider: params.provider, value }),
  };
}

export function createSearchProviderErrorResult(
  error: string,
  message: string,
  docs: string = WEB_SEARCH_DOCS_URL,
): { error: string; message: string; docs: string } {
  return { error, message, docs };
}

export function createMissingSearchKeyPayload(
  error: string,
  message: string,
): { error: string; message: string; docs: string } {
  return createSearchProviderErrorResult(error, message);
}

export function rejectUnsupportedSearchFilters(params: {
  providerName: string;
  request: Pick<
    SearchProviderRequest,
    "country" | "language" | "freshness" | "dateAfter" | "dateBefore" | "domainFilter"
  >;
  support: SearchProviderFilterSupport;
}): { error: string; message: string; docs: string } | undefined {
  const provider = params.providerName;
  if (params.request.country && params.support.country !== true) {
    return createSearchProviderErrorResult(
      "unsupported_country",
      `country filtering is not supported by the ${provider} provider. Only Brave and Perplexity support country filtering.`,
    );
  }
  if (params.request.language && params.support.language !== true) {
    return createSearchProviderErrorResult(
      "unsupported_language",
      `language filtering is not supported by the ${provider} provider. Only Brave and Perplexity support language filtering.`,
    );
  }
  if (params.request.freshness && params.support.freshness !== true) {
    return createSearchProviderErrorResult(
      "unsupported_freshness",
      `freshness filtering is not supported by the ${provider} provider. Only Brave and Perplexity support freshness.`,
    );
  }
  if ((params.request.dateAfter || params.request.dateBefore) && params.support.date !== true) {
    return createSearchProviderErrorResult(
      "unsupported_date_filter",
      `date_after/date_before filtering is not supported by the ${provider} provider. Only Brave and Perplexity support date filtering.`,
    );
  }
  if (params.request.domainFilter?.length && params.support.domainFilter !== true) {
    return createSearchProviderErrorResult(
      "unsupported_domain_filter",
      `domain_filter is not supported by the ${provider} provider. Only Perplexity supports domain filtering.`,
    );
  }
  return undefined;
}

export function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

export function buildSearchRequestCacheIdentity(params: {
  query: string;
  count: number;
  country?: string;
  language?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  domainFilter?: string[];
  maxTokens?: number;
  maxTokensPerPage?: number;
}): string {
  return [
    params.query,
    params.count,
    params.country || "default",
    params.language || "default",
    params.freshness || "default",
    params.dateAfter || "default",
    params.dateBefore || "default",
    params.domainFilter?.join(",") || "default",
    params.maxTokens || "default",
    params.maxTokensPerPage || "default",
  ].join(":");
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function normalizeDateInputToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return isValidIsoDate(trimmed) ? trimmed : undefined;
  }
  const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
  if (match) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

function getScopedSearchConfig(
  search: Record<string, unknown>,
  provider: string,
): Record<string, unknown> | undefined {
  if (provider === "brave") {
    return search;
  }
  const scoped = search[provider];
  return typeof scoped === "object" && scoped !== null && !Array.isArray(scoped)
    ? (scoped as Record<string, unknown>)
    : undefined;
}

export function readSearchProviderApiKeyValue(
  search: Record<string, unknown> | undefined,
  provider: string,
): unknown {
  if (!search) {
    return undefined;
  }
  return getScopedSearchConfig(search, provider)?.apiKey;
}

export function writeSearchProviderApiKeyValue(params: {
  search: Record<string, unknown>;
  provider: string;
  value: unknown;
}): void {
  if (params.provider === "brave") {
    params.search.apiKey = params.value;
    return;
  }
  const current = getScopedSearchConfig(params.search, params.provider);
  if (current) {
    current.apiKey = params.value;
    return;
  }
  params.search[params.provider] = { apiKey: params.value };
}
