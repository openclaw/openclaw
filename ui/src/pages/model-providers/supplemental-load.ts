import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import type { ModelProvidersData } from "./load.ts";

type SupplementalOptions = {
  isCoreLoading: () => boolean;
  getGateway: () => Pick<GatewayPageBinding, "connected" | "client" | "epoch" | "isCurrent">;
  getData: () => ModelProvidersData | null;
  getDataClient: () => GatewayBrowserClient | null;
  setData: (data: ModelProvidersData) => void;
  setDataClient: (client: GatewayBrowserClient | null) => void;
  refreshPolicy: UsageRefreshPolicy;
};

/** Loads provider usage after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private request: AbortController | null = null;
  private forceReload = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: SupplementalOptions,
  ) {}

  get loading(): boolean {
    return this.request !== null;
  }

  adoptCoreData(client: GatewayBrowserClient | null, data: ModelProvidersData): void {
    const previous = client === this.options.getDataClient() ? this.options.getData() : null;
    // Keep the last supplemental snapshot visible until its replacement finishes.
    this.options.setData({
      ...data,
      providerUsage: previous?.providerUsage ?? data.providerUsage,
      providerUsageFailed: previous?.providerUsageFailed ?? data.providerUsageFailed,
    });
    this.options.setDataClient(client);
    if (data.providerUsageFailed) {
      this.options.refreshPolicy.markProviderUsage(
        { ok: false },
        data.updatedAt,
        this.options.getGateway().epoch,
      );
    } else if (data.providerUsage !== null) {
      this.options.refreshPolicy.markProviderUsage(
        { ok: true, value: data.providerUsage },
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
      (previous?.providerUsage == null || this.forceReload) &&
      data.providerUsage === null &&
      !data.providerUsageFailed
    ) {
      this.forceReload = false;
      void this.loadUsage(client);
    }
  }

  resume(): void {
    const data = this.options.getData();
    const client = this.options.getDataClient();
    if (data?.providerUsage === null && !data.providerUsageFailed && client) {
      this.adoptCoreData(client, data);
    }
  }

  invalidate(): void {
    this.forceReload = true;
    this.options.refreshPolicy.interrupt();
    this.cancelGeneration();
  }

  beginCoreRefresh(force: boolean): void {
    if (force) {
      this.cancelGeneration();
      this.forceReload = true;
      this.options.refreshPolicy.resetPayload();
    }
  }

  private cancelGeneration(): void {
    this.request?.abort();
    this.request = null;
    this.notify();
  }

  async loadUsage(explicitClient?: GatewayBrowserClient): Promise<void> {
    const gateway = this.options.getGateway();
    const client = explicitClient ?? gateway.client;
    if (!gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return;
    }
    this.options.refreshPolicy.beginLoad();
    const epoch = gateway.epoch;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.notify();
    try {
      const providerUsage = await requestProviderUsage(client, { signal: request.signal });
      if (this.request !== request) {
        return;
      }
      const current = this.options.getData();
      if (
        current &&
        client === this.options.getDataClient() &&
        this.options.getGateway().isCurrent({ client, epoch })
      ) {
        this.options.setData({
          ...current,
          providerUsage: providerUsage.ok ? providerUsage.value : current.providerUsage,
          providerUsageFailed: !providerUsage.ok,
        });
        this.options.refreshPolicy.markProviderUsage(providerUsage, Date.now(), epoch);
      }
    } catch {
      // Supplemental failures leave the previous snapshot visible.
    } finally {
      if (this.request === request) {
        this.request = null;
        this.options.refreshPolicy.flushPending();
        this.notify();
      }
    }
  }
}
