import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveControlUiAuthCandidates,
  type ControlUiAuthSource,
} from "../../app/control-ui-auth.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import { PluginIconController, pluginIconFetchContext } from "./plugin-icon-controller.ts";

type PluginsPageIconsHost = {
  getContext: () => ApplicationContext;
  isConnected: () => boolean;
  onInstalledUrlsChange: (urls: Record<string, string>) => void;
  onCatalogUrlsChange: (urls: Record<string, string>) => void;
  onLoadingChange?: () => void;
};

function renderedPluginIds(view: ParentNode): Set<string> {
  return new Set(
    Array.from(
      view.querySelectorAll<HTMLElement>("[data-plugin-icon-id]"),
      (tile) => tile.dataset.pluginIconId ?? "",
    ).filter(Boolean),
  );
}

export class PluginsPageIcons {
  private authCandidates: string[] = [];
  readonly installed: PluginIconController;
  readonly catalog: PluginIconController;

  constructor(host: PluginsPageIconsHost) {
    const shared = {
      getFetchContext: () => pluginIconFetchContext(host.getContext()),
      isConnected: host.isConnected,
      onLoadingChange: host.onLoadingChange,
    };
    this.installed = new PluginIconController({
      ...shared,
      getFetchContext: () => ({
        ...shared.getFetchContext(),
        theme: host.getContext().theme.resolvedMode,
      }),
      onUrlsChange: host.onInstalledUrlsChange,
    });
    this.catalog = new PluginIconController({
      kind: "catalog",
      ...shared,
      onUrlsChange: host.onCatalogUrlsChange,
    });
  }

  updateAuth(source: ControlUiAuthSource): boolean {
    const next = resolveControlUiAuthCandidates(source);
    const changed =
      next.length !== this.authCandidates.length ||
      next.some((candidate, index) => candidate !== this.authCandidates[index]);
    this.authCandidates = next;
    return changed;
  }

  syncInstalled(result: PluginListResult | null, view: ParentNode): void {
    // Rendered tile markers preserve the inventory's sorting, filtering, and collapse policy.
    this.installed.sync(result, renderedPluginIds(view));
  }

  syncCatalog(
    discovery: Pick<PluginDiscoveryController, "result" | "featured" | "trending">,
    view: ParentNode,
    detail?: PluginDiscoveryDetailResult | null,
  ): void {
    const rendered = renderedPluginIds(view);
    this.catalog.syncCatalog(
      [
        ...(discovery.result?.items ?? []),
        ...discovery.featured,
        ...discovery.trending,
        ...(detail ? [detail.plugin] : []),
      ],
      detail?.detail.author?.imageUrl ? [detail.detail.author.imageUrl] : [],
      rendered,
    );
  }

  reset(): void {
    this.installed.reset();
    this.catalog.reset();
  }
}
