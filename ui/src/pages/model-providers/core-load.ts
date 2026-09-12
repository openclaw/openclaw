import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
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
  isCatalogLoading: () => boolean;
  refreshPublication: () => void;
};

export class ModelProviderCoreLoader {
  private active = false;
  private publicationPending = false;
  private readonly task: Task<[CoreRequest | null], CoreRequest & { data: ModelProvidersData }>;

  constructor(
    host: ReactiveControllerHost,
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

  refresh(client: GatewayBrowserClient, agentId: string, reason: ModelProviderRefreshReason) {
    if (reason === "publication" && (this.active || this.options.isCatalogLoading())) {
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
    this.options.onStart(reason);
    return this.task.run([{ client, agentId, reason }]);
  }

  invalidate(): void {
    this.publicationPending = false;
    this.active = false;
    void this.task.run([null]);
  }

  private settle(): void {
    this.active = false;
    this.flushPublication();
  }

  flushPublication(): void {
    // Task commits its status and value after onComplete/onError returns.
    queueMicrotask(() => {
      if (this.publicationPending && !this.active && !this.options.isCatalogLoading()) {
        this.options.refreshPublication();
      }
    });
  }
}
