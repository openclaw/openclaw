import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveControlUiAuthCandidates,
  type ControlUiAuthSource,
} from "../../app/control-ui-auth.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import type { createPluginDiscovery } from "./plugin-discovery.ts";
import { PluginIconOwner, pluginIconFetchContext } from "./plugin-icon-owner.ts";

export function createPluginsPageIcons(host: {
  getContext: () => ApplicationContext;
  isConnected: () => boolean;
  onInstalledUrlsChange: (urls: Record<string, string>) => void;
  onCatalogUrlsChange: (urls: Record<string, string>) => void;
  onChange?: () => void;
}) {
  let authCandidates: string[] = [];
  const tiles = new Set<() => string>();
  const shared = {
    getFetchContext: () => pluginIconFetchContext(host.getContext()),
    isConnected: host.isConnected,
    onLoadingChange: host.onChange,
  };
  const installed = new PluginIconOwner({
    ...shared,
    onUrlsChange: host.onInstalledUrlsChange,
  });
  const catalog = new PluginIconOwner({
    kind: "catalog",
    ...shared,
    onUrlsChange: host.onCatalogUrlsChange,
  });

  return {
    installed,
    catalog,
    updateAuth(source: ControlUiAuthSource): boolean {
      const next = resolveControlUiAuthCandidates(source);
      const changed =
        next.length !== authCandidates.length ||
        next.some((candidate, index) => candidate !== authCandidates[index]);
      authCandidates = next;
      return changed;
    },
    sync(
      result: PluginListResult | null,
      discovery: Pick<
        ReturnType<ReturnType<typeof createPluginDiscovery>["read"]>,
        "result" | "featured" | "trending"
      >,
      rendered: ReadonlySet<string>,
      detail?: PluginDiscoveryDetailResult | null,
    ): void {
      // Both inventories follow the same rendered sorting, filtering, and collapse policy.
      installed.sync(result, rendered);
      catalog.syncCatalog(
        [
          ...(discovery.result?.items ?? []),
          ...discovery.featured,
          ...discovery.trending,
          ...(detail ? [detail.plugin] : []),
        ],
        detail?.detail.author?.imageUrl ? [detail.detail.author.imageUrl] : [],
        rendered,
      );
    },
    reset(): void {
      installed.reset();
      catalog.reset();
    },
    rendered: () => new Set(Array.from(tiles, (readId) => readId()).filter(Boolean)),
    register(this: void, readId: () => string) {
      tiles.add(readId);
      host.onChange?.();
      return () => tiles.delete(readId);
    },
  };
}
