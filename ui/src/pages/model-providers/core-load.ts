import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import { loadModelProvidersData, type ModelProvidersData } from "./load.ts";
import type { ControllerHost } from "./page-controller.ts";

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
};

export class ModelProviderCoreLoader {
  private active = false;
  private catalogRequest: AbortController | null = null;
  catalogError: string | null = null;
  private request: AbortController | null = null;

  constructor(
    private readonly host: ControllerHost,
    private readonly options: CoreLoadOptions,
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
      }
    }
  }

  async refresh(
    client: GatewayBrowserClient,
    agentId: string,
    reason: ModelProviderRefreshReason,
  ): Promise<void> {
    if (reason === "publication" && (this.active || this.catalogLoading)) {
      // Catalog changes during an existing read are best effort until the next refresh.
      return;
    }
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.active = true;
    if (reason !== "publication") {
      this.resetCatalog();
    }
    this.options.onStart(reason);
    this.host.requestUpdate();
    try {
      const data = await loadModelProvidersData(client, {
        agentId,
        ...(reason === "forced" ? { refresh: true } : {}),
        signal: request.signal,
      });
      if (this.request === request) {
        this.active = false;
        this.options.onComplete({ client, agentId, reason, data });
      }
    } catch {
      // Each source reports its own error; a retired request has no result to publish.
    } finally {
      if (this.request === request) {
        this.request = null;
        this.active = false;
        this.host.requestUpdate();
      }
    }
  }

  invalidate(): void {
    this.resetCatalog();
    this.active = false;
    this.request?.abort();
    this.request = null;
    this.host.requestUpdate();
  }
}
