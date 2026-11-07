import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "../../lib/model-catalog-store.ts";
import {
  catalogDiscoveryError,
  EMPTY_MODEL_PROVIDERS_DATA,
  startModelProvidersData,
  type ModelProvidersCatalogData,
  type ModelProvidersData,
} from "./load.ts";
import type { ModelProvidersRouteData } from "./route.ts";

export type ModelProviderRefreshReason = "publication" | "replacement" | "forced";

export type ModelProviderCatalogReceipt = { promise: Promise<string | null> };

// One credential save publishes several catalog changes within a few hundred
// milliseconds; a bounded window turns that burst into one reload.
const PUBLICATION_SETTLE_MS = 150;

type ModelProviderRefreshTarget = { providerId?: string; data: ModelProvidersData };

function mergeConnectedProviderData(
  refreshed: ModelProvidersData,
  target: { providerId?: string; data: ModelProvidersData },
): ModelProvidersData {
  const authStatus = refreshed.authStatus;
  return {
    ...target.data,
    providerOutcomes: refreshed.providerOutcomes,
    pendingProviders: refreshed.pendingProviders,
    catalogRequestFailed: refreshed.catalogRequestFailed,
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
  private scheduledPublication: {
    timer: ReturnType<typeof setTimeout>;
    done: ReturnType<typeof Promise.withResolvers<void>>;
    run: () => Promise<void>;
  } | null = null;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      onStart: (reason: ModelProviderRefreshReason) => void;
      onComplete: (result: { client: GatewayBrowserClient; data: ModelProvidersData }) => void;
      onCatalogComplete: (result: ModelProvidersCatalogData) => void;
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

  discoverCatalog(
    client: GatewayBrowserClient,
    agentId: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    return this.adoptCatalog(
      async (signal) => {
        const result = await loadModelCatalog(client, { agentId, refresh: true, signal });
        return {
          providerOutcomes: result.providerOutcomes ?? [],
          pendingProviders: result.pendingProviders ?? [],
          catalogRequestFailed: false,
          catalogError: catalogDiscoveryError(result),
        };
      },
      client,
      agentId,
      isCurrent,
    );
  }

  async adoptPreloadedCatalog(
    data: ModelProvidersRouteData,
    isCurrent: () => boolean,
  ): Promise<void> {
    const { client, agentId, catalog } = data;
    if (!client || !agentId) {
      return;
    }
    // The catalog can change after preload completes but before this page subscribes.
    const scope = { agentId };
    const stale =
      peekModelCatalog(client, scope, { allowStale: true }) !== undefined &&
      peekModelCatalog(client, scope) === undefined;
    if (catalog) {
      await this.adoptCatalog(
        () => catalog.promise,
        client,
        agentId,
        isCurrent,
        catalog.controller,
      );
    }
    if (stale && isCurrent()) {
      await this.discoverCatalog(client, agentId, isCurrent);
    }
  }

  private async adoptCatalog(
    load: (signal: AbortSignal) => Promise<ModelProvidersCatalogData>,
    client: GatewayBrowserClient,
    agentId: string,
    isCurrent: () => boolean,
    request = new AbortController(),
  ): Promise<void> {
    if (this.catalogRequest) {
      return;
    }
    const ownsResult = () => this.catalogRequest === request && isCurrent();
    this.catalogRequest = request;
    this.catalogCompletion = Promise.withResolvers<string | null>();
    this.catalogReceipt = { promise: this.catalogCompletion.promise };
    this.catalogError = null;
    this.notify();
    try {
      const data = await load(request.signal);
      if (ownsResult()) {
        this.catalogError = data.catalogError;
        this.options.onCatalogComplete(data);
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

  refresh(
    client: GatewayBrowserClient,
    agentId: string,
    reason: ModelProviderRefreshReason,
    target?: ModelProviderRefreshTarget,
  ): Promise<void> {
    if (reason !== "publication") {
      // An explicit reload reads everything a pending publication would.
      this.cancelScheduledPublication();
      return this.load(client, agentId, reason, target);
    }
    if (this.active || this.catalogLoading) {
      // The active read's catch-up already re-reads after this notification.
      this.publicationPending = true;
      return Promise.resolve();
    }
    const run = () => this.load(client, agentId, reason, target);
    if (this.scheduledPublication) {
      // The latest notification's scope wins; all callers share one reload.
      this.scheduledPublication.run = run;
      return this.scheduledPublication.done.promise;
    }
    const done = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      const scheduled = this.scheduledPublication;
      this.scheduledPublication = null;
      void scheduled?.run().finally(done.resolve);
    }, PUBLICATION_SETTLE_MS);
    this.scheduledPublication = { timer, done, run };
    return done.promise;
  }

  private cancelScheduledPublication(): void {
    const scheduled = this.scheduledPublication;
    this.scheduledPublication = null;
    if (scheduled) {
      clearTimeout(scheduled.timer);
      scheduled.done.resolve();
    }
  }

  private async load(
    client: GatewayBrowserClient,
    agentId: string,
    reason: ModelProviderRefreshReason,
    target?: ModelProviderRefreshTarget,
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
      const read = startModelProvidersData(client, {
        agentId,
        ...(target || reason === "forced" ? { refresh: true } : {}),
        signal: request.signal,
      });
      const refreshed = { ...EMPTY_MODEL_PROVIDERS_DATA, ...(await read.auth) };
      if (this.request === request) {
        // A page refresh takes over any picker retry started while auth waited.
        this.resetCatalog();
        // Publish auth with catalog progress already owned, so unknown models
        // cannot briefly appear as an empty, completed discovery.
        const catalog = this.adoptCatalog(
          () => read.catalog,
          client,
          agentId,
          () => this.request === request,
          request,
        );
        const data = target ? mergeConnectedProviderData(refreshed, target) : refreshed;
        this.retryProvider = target && data.error ? target.providerId : undefined;
        this.options.onComplete({ client, data });
        await catalog;
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
    this.cancelScheduledPublication();
    this.resetCatalog();
    this.retryProvider = undefined;
    this.active = false;
    this.request?.abort();
    this.request = null;
    this.notify();
  }
}
