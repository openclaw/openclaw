import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import {
  loadPluginDiscoveryDetail,
  type PluginCatalogItem,
  type PluginDiscoveryDetailResult,
} from "../../lib/plugins/index.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Local inspection owns availability; optional metadata never delays the installed controls. */
export async function loadInstalledPluginDetail(params: {
  plugin: PluginCatalogItem;
  detail: PluginsPageDetail;
  client: GatewayBrowserClient;
  catalog?: PluginDiscoveryDetailResult;
  includeTools: boolean;
  isCurrent: () => boolean;
  onChange: (detail: PluginsPageDetail) => void;
}): Promise<void> {
  const { plugin, client } = params;
  let detail = params.detail;
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
    publish({ pluginId: plugin.id, inspection, error: null });
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
    if (params.catalog?.plugin.local.pluginId === plugin.id) {
      publish({ ...detail, inspection: { ...inspection, catalog: params.catalog } });
      return;
    }
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
      publish({ ...detail, inspection: { ...inspection, catalog } });
    } catch {
      // Remote enrichment is optional; local capabilities and controls are already visible.
    }
  } catch (error) {
    publish({ ...detail, error: formatUiError(error) });
  }
}
