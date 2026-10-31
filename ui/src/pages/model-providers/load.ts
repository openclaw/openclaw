import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
// Fetches the gateway signals behind the Models settings page.
// Each source degrades independently: unavailable usage data must not blank
// the provider list.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ModelAuthStatusResult,
  ModelCatalogProviderOutcome,
  ModelCatalogResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";

registerSettingsEnglish();

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  /** Operation diagnostics; picker facts are owned by the shared catalog store. */
  providerOutcomes: ModelCatalogProviderOutcome[];
  catalogError: string | null;
  providerUsage: UsageSummary | null;
  providerUsageFailed: boolean;
  updatedAt: number | null;
  error: string | null;
};

type RequestResult<T> = { ok: true; result: T } | { ok: false; error: unknown };

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  providerOutcomes: [],
  catalogError: null,
  providerUsage: null,
  providerUsageFailed: false,
  updatedAt: null,
  error: null,
};

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("model providers");
  }
  return formatUiError(error, "request failed");
}

function settleRequest<T>(promise: Promise<T>): Promise<RequestResult<T>> {
  return promise.then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  );
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts: { agentId: string; refresh?: boolean; signal?: AbortSignal },
): Promise<ModelProvidersData> {
  const loadConfiguredCatalog = (refresh = false) =>
    settleRequest(
      loadModelCatalog(client, {
        agentId: opts.agentId,
        ...(refresh ? { refresh: true } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
  const authStatusLoad = settleRequest(loadModelAuthStatus(client, opts));
  // Auth refresh publishes the runtime owner that the catalog must read.
  const catalogRefresh = opts.refresh
    ? authStatusLoad.then(() => loadConfiguredCatalog(true))
    : undefined;
  const catalogLoad = catalogRefresh
    ? catalogRefresh.then((refreshResult) =>
        refreshResult.ok ? refreshResult : loadConfiguredCatalog(),
      )
    : loadConfiguredCatalog();
  const [authStatus, catalog, refreshResult] = await Promise.all([
    authStatusLoad,
    catalogLoad,
    catalogRefresh ?? Promise.resolve(undefined),
  ]);
  return {
    authStatus: authStatus.ok ? authStatus.result : null,
    providerOutcomes: catalog.ok ? (catalog.result.providerOutcomes ?? []) : [],
    catalogError:
      refreshResult && !refreshResult.ok
        ? errorMessage(refreshResult.error)
        : catalog.ok
          ? catalogDiscoveryError(catalog.result)
          : errorMessage(catalog.error),
    providerUsage: null,
    providerUsageFailed: false,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok
      ? (authStatus.result.unavailable?.message ?? null)
      : errorMessage(authStatus.error),
  };
}

/** Names the providers whose listing failed, so the warning points at its cause. */
export function catalogDiscoveryError(result: ModelCatalogResult): string | null {
  const failed = new Set(
    (result.providerOutcomes ?? [])
      .filter((outcome) => outcome.status === "unavailable")
      .map((outcome) => outcome.provider),
  );
  return modelCatalogRefreshError(
    result,
    failed.size
      ? t("modelProviders.defaults.discoverFailedFor", { providers: [...failed].join(", ") })
      : t("modelProviders.defaults.discoverFailed"),
  );
}
