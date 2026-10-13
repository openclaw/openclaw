import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import { loadModelProviderCost, type ModelProvidersData } from "./load.ts";
import type { ControllerHost } from "./page-controller.ts";

type SupplementalOptions = {
  isCoreLoading: () => boolean;
  getGateway: () => Pick<GatewayPageController, "connected" | "client" | "epoch" | "isCurrent">;
  getData: () => ModelProvidersData | null;
  getDataClient: () => GatewayBrowserClient | null;
  setData: (data: ModelProvidersData) => void;
  setDataClient: (client: GatewayBrowserClient | null) => void;
  refreshPolicy: UsageRefreshPolicy;
};

type SupplementalKind = "usage" | "cost";

/** Loads usage and cost after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private readonly requests = new Map<SupplementalKind, AbortController>();

  constructor(
    private readonly host: ControllerHost,
    private readonly options: SupplementalOptions,
  ) {}

  get loading(): boolean {
    return this.requests.size > 0;
  }

  get usageLoading(): boolean {
    return this.requests.has("usage");
  }

  adoptCoreData(
    client: GatewayBrowserClient | null,
    data: ModelProvidersData,
    options: { preserveCatalogDiagnostics?: boolean } = {},
  ): void {
    const previous = client === this.options.getDataClient() ? this.options.getData() : null;
    // Keep the last supplemental snapshot visible until its replacement finishes.
    this.options.setData({
      ...data,
      // A newer Retry owns its feedback even when an older auth read finishes afterward.
      ...(options.preserveCatalogDiagnostics && previous
        ? {
            providerOutcomes: previous.providerOutcomes,
            catalogError: previous.catalogError,
          }
        : {}),
      providerUsage: previous?.providerUsage ?? data.providerUsage,
      costByProvider: previous?.costByProvider ?? data.costByProvider,
    });
    this.options.setDataClient(client);
    if (data.providerUsage !== null) {
      this.options.refreshPolicy.markProviderUsage(
        data.providerUsage,
        data.updatedAt,
        this.options.getGateway().epoch,
      );
    }
    // Cached core data stays visible during route reloads; only the settled
    // loader starts supplemental work, so adopting its result cannot duplicate it.
    if (
      client &&
      !this.options.isCoreLoading() &&
      !this.loading &&
      data.providerUsage === null &&
      data.costByProvider === null
    ) {
      void this.loadRequests(client, true);
    }
  }

  invalidate(): void {
    this.options.refreshPolicy.interrupt();
    this.cancelGeneration();
  }

  beginCoreRefresh(force: boolean): void {
    this.cancelGeneration();
    if (force) {
      this.options.refreshPolicy.resetPayload();
    }
  }

  private cancelGeneration(): void {
    const retired = [...this.requests.values()];
    this.requests.clear();
    for (const request of retired) {
      request.abort();
    }
    this.host.requestUpdate();
  }

  loadUsage(): Promise<void> {
    return this.loadRequests(undefined, false);
  }

  private async loadRequests(
    explicitClient: GatewayBrowserClient | undefined,
    includeCost: boolean,
  ): Promise<void> {
    const gateway = this.options.getGateway();
    const client = explicitClient ?? gateway.client;
    if (!gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return;
    }
    this.options.refreshPolicy.beginLoad();
    const usage = this.loadSupplement("usage", client, gateway.epoch);
    if (!includeCost) {
      await usage;
      return;
    }
    await Promise.all([usage, this.loadSupplement("cost", client, gateway.epoch)]);
  }

  private async loadSupplement(
    kind: SupplementalKind,
    client: GatewayBrowserClient,
    epoch: number,
  ): Promise<void> {
    this.requests.get(kind)?.abort();
    const request = new AbortController();
    this.requests.set(kind, request);
    this.host.requestUpdate();
    try {
      const patch:
        | { providerUsage: ProviderUsageRequestResult }
        | { costByProvider: Awaited<ReturnType<typeof loadModelProviderCost>> } =
        kind === "usage"
          ? { providerUsage: await requestProviderUsage(client, { signal: request.signal }) }
          : { costByProvider: await loadModelProviderCost(client, request.signal) };
      if (this.requests.get(kind) !== request) {
        return;
      }
      const current = this.options.getData();
      if (
        current &&
        client === this.options.getDataClient() &&
        this.options.getGateway().isCurrent({ client, epoch })
      ) {
        this.options.setData({ ...current, ...patch });
        if ("providerUsage" in patch) {
          this.options.refreshPolicy.markProviderUsage(patch.providerUsage, Date.now(), epoch);
        }
      }
    } catch {
      // Supplemental failures leave the previous snapshot visible.
    } finally {
      if (this.requests.get(kind) === request) {
        this.requests.delete(kind);
        this.options.refreshPolicy.flushPending();
        this.host.requestUpdate();
      }
    }
  }
}
