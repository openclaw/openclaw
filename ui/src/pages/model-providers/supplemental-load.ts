import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import type { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import type { ModelProvidersData } from "./load.ts";

/** Loads provider usage after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private request: AbortController | null = null;
  private forceReload = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      isCoreLoading: () => boolean;
      getGateway: () => Pick<GatewayPageBinding, "connected" | "client" | "epoch" | "isCurrent">;
      getData: () => ModelProvidersData | null;
      getDataClient: () => GatewayBrowserClient | null;
      setData: (data: ModelProvidersData) => void;
      setDataClient: (client: GatewayBrowserClient | null) => void;
      refreshPolicy: UsageRefreshPolicy;
    },
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
    if (data.providerUsageFailed || data.providerUsage !== null) {
      this.forceReload = false;
      this.options.refreshPolicy.markProviderLoaded(
        data.providerUsageFailed || data.providerUsage?.refreshing === true
          ? null
          : (data.updatedAt ?? Date.now()),
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
      void this.loadUsage(client);
    }
  }

  resume(): void {
    const data = this.options.getData();
    const client = this.options.getDataClient();
    if (
      data &&
      client &&
      !this.options.isCoreLoading() &&
      !this.loading &&
      (this.forceReload || (data.providerUsage === null && !data.providerUsageFailed))
    ) {
      void this.loadUsage(client);
    }
  }

  invalidate(): void {
    this.forceReload = true;
    this.options.refreshPolicy.resetPayload();
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
    if (!gateway.connected || !client || client !== this.options.getDataClient()) {
      return;
    }
    this.forceReload = false;
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
        this.options.refreshPolicy.markProviderLoaded(
          providerUsage.ok && providerUsage.value.refreshing !== true ? Date.now() : null,
        );
      }
    } catch {
      // Supplemental failures leave the previous snapshot visible.
    } finally {
      if (this.request === request) {
        this.request = null;
        void this.options.refreshPolicy.flushPending();
        this.notify();
      }
    }
  }
}
