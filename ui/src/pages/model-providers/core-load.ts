import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import { loadModelProvidersData, type ModelProvidersData } from "./load.ts";

export type ModelProviderRefreshReason = "publication" | "replacement" | "forced";

export type ModelProviderCatalogReceipt = { promise: Promise<string | null> };

async function loadConnectedProviderData(
  client: GatewayBrowserClient,
  agentId: string,
  target: { providerId?: string; data: ModelProvidersData },
  signal: AbortSignal,
): Promise<ModelProvidersData> {
  // Read auth first so the catalog sees the newly connected runtime. This one
  // shared refresh absorbs the intermediate catalog invalidations during login.
  const refreshed = await loadModelProvidersData(client, { agentId, refresh: true, signal });
  const authStatus = refreshed.authStatus;
  return {
    ...target.data,
    providerOutcomes: refreshed.providerOutcomes,
    catalogError: refreshed.catalogError,
    error: authStatus ? refreshed.error : t("modelProviders.login.statusRefreshFailed"),
    authStatus:
      authStatus && target.providerId
        ? {
            ...authStatus,
            providers: [
              ...(target.data.authStatus?.providers ?? []).filter(
                (provider) => canonicalModelAuthProviderId(provider.provider) !== target.providerId,
              ),
              ...authStatus.providers.filter(
                (provider) => canonicalModelAuthProviderId(provider.provider) === target.providerId,
              ),
            ],
          }
        : (authStatus ?? target.data.authStatus),
  };
}

export class ModelProviderCoreLoader {
  private active = false;
  private catalogRequest: AbortController | null = null;
  catalogReceipt: ModelProviderCatalogReceipt | null = null;
  private catalogCompletion: ReturnType<typeof Promise.withResolvers<string | null>> | null = null;
  catalogError: string | null = null;
  retryProvider: string | undefined;
  private request: AbortController | null = null;
  private publicationPending = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      onStart: (reason: ModelProviderRefreshReason) => void;
      onComplete: (result: { client: GatewayBrowserClient; data: ModelProvidersData }) => void;
      onCatalogComplete: (result: ModelCatalogResult) => void;
    },
  ) {}

  get loading(): boolean {
    return this.active;
  }

  get catalogLoading(): boolean {
    return this.catalogRequest !== null;
  }

  resetCatalog(): void {
    const retired = this.catalogRequest;
    this.catalogRequest = null;
    this.catalogError = null;
    // Release the retired presentation even if its transport ignores abort.
    this.catalogCompletion?.resolve(null);
    this.catalogCompletion = null;
    this.catalogReceipt = null;
    retired?.abort();
    this.notify();
  }

  async discoverCatalog(
    client: GatewayBrowserClient,
    agentId: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.catalogRequest) {
      return;
    }
    const request = new AbortController();
    const ownsResult = () => this.catalogRequest === request && isCurrent();
    this.catalogRequest = request;
    this.catalogCompletion = Promise.withResolvers<string | null>();
    this.catalogReceipt = { promise: this.catalogCompletion.promise };
    this.catalogError = null;
    this.notify();
    try {
      const result = await loadModelCatalog(client, {
        agentId,
        includeDetails: true,
        refresh: true,
        signal: request.signal,
      });
      if (ownsResult()) {
        this.catalogError = modelCatalogRefreshError(
          result,
          t("modelProviders.defaults.discoverFailed"),
        );
        this.options.onCatalogComplete(result);
      }
    } catch (failure) {
      if (ownsResult()) {
        this.catalogError = formatUiError(failure, "request failed");
      }
    } finally {
      if (this.catalogRequest === request) {
        this.catalogRequest = null;
        this.catalogCompletion?.resolve(this.catalogError);
        this.catalogCompletion = null;
        this.refreshPendingPublication(client, agentId);
        this.notify();
      }
    }
  }

  async refresh(
    client: GatewayBrowserClient,
    agentId: string,
    reason: ModelProviderRefreshReason,
    target?: { providerId?: string; data: ModelProvidersData },
  ): Promise<void> {
    if (reason === "publication" && (this.active || this.catalogLoading)) {
      this.publicationPending = true;
      return;
    }
    this.publicationPending = false;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.active = true;
    if (reason !== "publication") {
      this.resetCatalog();
    }
    if (!target) {
      this.options.onStart(reason);
    }
    this.notify();
    try {
      const data = target
        ? await loadConnectedProviderData(client, agentId, target, request.signal)
        : await loadModelProvidersData(client, {
            agentId,
            ...(reason === "forced" ? { refresh: true } : {}),
            signal: request.signal,
          });
      if (this.request === request) {
        this.active = false;
        this.retryProvider = target && data.error ? target.providerId : undefined;
        this.options.onComplete({ client, data });
      }
    } catch {
      // Each source reports its own error; a retired request has no result to publish.
    } finally {
      if (this.request === request) {
        this.request = null;
        this.active = false;
        this.refreshPendingPublication(client, agentId);
        this.notify();
      }
    }
  }

  private refreshPendingPublication(client: GatewayBrowserClient, agentId: string): void {
    if (this.publicationPending && !this.active && !this.catalogLoading) {
      // A completed read may have republished facts captured before the notification.
      invalidateModelCatalogCache(client, { agentId });
      void this.refresh(client, agentId, "publication");
    }
  }

  invalidate(): void {
    this.publicationPending = false;
    this.resetCatalog();
    this.retryProvider = undefined;
    this.active = false;
    this.request?.abort();
    this.request = null;
    this.notify();
  }
}
