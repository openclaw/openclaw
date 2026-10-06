import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import { loadModelProvidersData, type ModelProvidersData } from "./load.ts";

export type ModelProviderRefreshReason = "publication" | "replacement" | "forced";

type CoreRequest = {
  client: GatewayBrowserClient;
  agentId: string;
  reason: ModelProviderRefreshReason;
};

type CoreLoadOptions = {
  onStart: (reason: ModelProviderRefreshReason) => void;
  onComplete: (result: CoreRequest & { data: ModelProvidersData }) => void;
  onCatalogComplete: (result: ModelCatalogResult) => void;
  refreshPublication: () => void;
};

export class ModelProviderCoreLoader {
  private active = false;
  private publicationPending = false;
  private catalogRequest: AbortController | null = null;
  catalogError: string | null = null;
  // The latest explicit Retry includes one that has already settled.
  catalogGeneration = 0;
  private readonly task: Task<[CoreRequest | null], CoreRequest & { data: ModelProvidersData }>;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: CoreLoadOptions,
  ) {
    this.task = new Task(host, {
      autoRun: false,
      task: ([request]: [CoreRequest | null], { signal }) =>
        request
          ? loadModelProvidersData(request.client, {
              agentId: request.agentId,
              ...(request.reason === "forced" ? { refresh: true } : {}),
              signal,
            }).then((data) => ({ ...request, data }))
          : initialState,
      onComplete: (result) => {
        this.settle();
        this.options.onComplete(result);
      },
      onError: () => this.settle(),
    });
  }

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
    retired?.abort();
    this.host.requestUpdate();
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
    this.catalogGeneration += 1;
    this.catalogError = null;
    this.host.requestUpdate();
    try {
      const result = await loadModelCatalog(client, {
        agentId,
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
        this.host.requestUpdate();
        this.flushPublication();
      }
    }
  }

  refresh(client: GatewayBrowserClient, agentId: string, reason: ModelProviderRefreshReason) {
    if (reason === "publication" && (this.active || this.catalogLoading)) {
      this.publicationPending = true;
      return Promise.resolve();
    }
    if (reason === "publication") {
      if (this.publicationPending) {
        // Auth refresh can create a display copy after this publication was queued.
        invalidateModelCatalogCache(client, { agentId });
      }
      this.publicationPending = false;
    }
    this.active = true;
    if (reason !== "publication") {
      this.resetCatalog();
    }
    this.options.onStart(reason);
    return this.task.run([{ client, agentId, reason }]);
  }

  invalidate(): void {
    this.resetCatalog();
    this.publicationPending = false;
    this.active = false;
    void this.task.run([null]);
  }

  private settle(): void {
    this.active = false;
    this.flushPublication();
  }

  private flushPublication(): void {
    // Task commits its status and value after onComplete/onError returns.
    queueMicrotask(() => {
      if (this.publicationPending && !this.active && !this.catalogLoading) {
        this.options.refreshPublication();
      }
    });
  }
}
