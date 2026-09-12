import type { ApplicationContext } from "../../app/context.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import { CatalogIconController } from "./catalog-icon-controller.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import { PluginIconController } from "./plugin-icon-controller.ts";

type PluginsPageIconsHost = {
  getContext: () => ApplicationContext;
  isConnected: () => boolean;
  onInstalledUrlsChange: (urls: Record<string, string>) => void;
  onCatalogUrlsChange: (urls: Record<string, string>) => void;
};

export class PluginsPageIcons {
  private readonly installed: PluginIconController;
  private readonly catalog: CatalogIconController;

  constructor(host: PluginsPageIconsHost) {
    const shared = {
      getFetchContext: () => {
        const context = host.getContext();
        return {
          resourceBasePath: context.resourceBasePath,
          gatewayUrl: context.gateway.connection.gatewayUrl,
          auth: {
            hello: context.gateway.snapshot.hello,
            settings: { token: context.gateway.connection.token },
            password: context.gateway.connection.password,
          },
        };
      },
      isConnected: host.isConnected,
    };
    this.installed = new PluginIconController({
      ...shared,
      onUrlsChange: host.onInstalledUrlsChange,
    });
    this.catalog = new CatalogIconController({
      ...shared,
      onUrlsChange: host.onCatalogUrlsChange,
    });
  }

  syncInstalled(result: PluginListResult | null, view: ParentNode): void {
    const renderedPluginIds = new Set<string>();
    // Rendered tile markers preserve the inventory's sorting, filtering, and collapse policy.
    for (const tile of view.querySelectorAll<HTMLElement>("[data-plugin-icon-id]")) {
      const pluginId = tile.dataset.pluginIconId;
      if (pluginId) {
        renderedPluginIds.add(pluginId);
      }
    }
    this.installed.sync(result, renderedPluginIds);
  }

  reconcileInstalled(result: PluginListResult | null): void {
    this.installed.reconcile(result);
  }

  invalidateInstalled(pluginId: string): void {
    this.installed.invalidate(pluginId);
  }

  handleInstalledError(pluginId: string): void {
    this.installed.handleError(pluginId);
  }

  syncCatalog(
    discovery: Pick<PluginDiscoveryController, "result" | "featured" | "trending">,
    detail?: PluginDiscoveryDetailResult | null,
  ): void {
    this.catalog.sync(
      [
        ...(discovery.result?.items ?? []),
        ...discovery.featured,
        ...discovery.trending,
        ...(detail ? [detail.plugin] : []),
      ],
      detail?.detail.author?.imageUrl ? [detail.detail.author.imageUrl] : [],
    );
  }

  resetInstalled(): void {
    this.installed.reset();
  }

  reset(): void {
    this.installed.reset();
    this.catalog.reset();
  }
}
