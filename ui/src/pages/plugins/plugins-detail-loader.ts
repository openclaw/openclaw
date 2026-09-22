import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import { loadPluginDiscoveryDetail, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Local inspection owns availability; optional metadata never delays the installed controls. */
export async function loadInstalledPluginDetail(params: {
  plugin: PluginCatalogItem;
  client: GatewayBrowserClient;
  initial: PluginsPageDetail;
  includeTools: boolean;
  isCurrent: () => boolean;
  onChange: (detail: PluginsPageDetail) => void;
}): Promise<void> {
  const { plugin, client } = params;
  let detail = params.initial;
  const publish = (next: PluginsPageDetail) => {
    if (!params.isCurrent()) {
      return;
    }
    detail = next;
    params.onChange(next);
  };
  const tools = params.includeTools
    ? client
        .request<ToolsCatalogResult>("tools.catalog", { includePlugins: true })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  try {
    const inspection = await inspectPlugin(client, plugin.id);
    if (!params.isCurrent()) {
      return;
    }
    publish({
      ...detail,
      inspection,
      tools: undefined,
      catalog: inspection.catalog ?? detail.catalog,
      catalogLoading: Boolean(plugin.catalogId && !inspection.catalog && !detail.catalog),
    });
    void tools.then((catalog) => {
      if (!catalog) {
        return;
      }
      const toolDetails = new Map<string, { name: string; description?: string }>(
        inspection.declared.tools.map((name) => [name, { name }]),
      );
      for (const group of catalog.groups.filter((entry) => entry.pluginId === plugin.id)) {
        for (const tool of group.tools) {
          toolDetails.set(tool.id, {
            name: tool.id,
            description: tool.fullDescription ?? tool.description,
          });
        }
      }
      publish({ ...detail, tools: [...toolDetails.values()] });
    });
    if (!plugin.catalogId) {
      return;
    }
    try {
      const catalog = await loadPluginDiscoveryDetail(
        client,
        plugin.catalogId,
        undefined,
        plugin.version,
      );
      publish({ ...detail, catalog, catalogLoading: false });
    } catch {
      // Remote enrichment is optional; settle its placeholder without hiding local controls.
      publish({ ...detail, catalogLoading: false });
    }
  } catch (error) {
    publish({ ...detail, error: formatUiError(error) });
  }
}
