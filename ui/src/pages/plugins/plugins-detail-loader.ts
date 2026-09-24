import type { ToolsCatalogResult } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import {
  loadPluginDiscoveryDetail,
  type PluginCatalogItem,
  type PluginDiscoveryDetailResult,
  type PluginListResult,
} from "../../lib/plugins/index.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import type { PluginsPageCatalogDetail, PluginsPageDetail } from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";

/** Local inspection owns availability; optional metadata never delays the installed controls. */
export async function loadInstalledPluginDetail(params: {
  pluginId: string | null;
  plugin: PluginCatalogItem | undefined;
  catalog: PluginDiscoveryDetailResult | null | undefined;
  gateway: GatewayPageController;
  canInspect: boolean;
  getDetail: () => PluginsPageDetail | null;
  onChange: (detail: PluginsPageDetail | null) => void;
}): Promise<void> {
  const { pluginId, plugin, catalog: cachedCatalog, gateway } = params;
  const current = params.getDetail();
  const previous = current?.pluginId === pluginId ? current : null;
  // Refresh presentation in place, but rotate request ownership even when reads
  // are paused for removal so an earlier inspection cannot publish a false error.
  const initial = pluginId
    ? {
        ...previous,
        pluginId,
        inspection: previous?.inspection ?? null,
        catalog:
          previous?.catalog ??
          (cachedCatalog && cachedCatalog.plugin.id === plugin?.catalogId
            ? cachedCatalog
            : undefined),
        error: null,
      }
    : null;
  params.onChange(initial);
  const scope = gateway.capture();
  if (!plugin?.installed || !initial || !scope || !params.canInspect) {
    return;
  }
  let detail: PluginsPageDetail = initial;
  const { client } = scope;
  const isCurrent = () => gateway.isCurrent(scope) && params.getDetail() === detail;
  const publish = (next: PluginsPageDetail) => {
    if (!isCurrent()) {
      return;
    }
    detail = next;
    params.onChange(next);
  };
  const tools =
    isGatewayMethodAdvertised({ hello: gateway.snapshot?.hello }, "tools.catalog") === true
      ? client
          .request<ToolsCatalogResult>("tools.catalog", { includePlugins: true })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  try {
    const inspection = await inspectPlugin(client, plugin.id);
    if (!isCurrent()) {
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

/** Reconcile the selected catalog identity against authoritative local inventory. */
export async function loadPluginCatalogDetail(params: {
  id: string | null;
  gateway: GatewayPageController;
  context: Pick<ApplicationContext, "replace" | "basePath">;
  location: PluginsRouteData["location"] | undefined;
  inventory: PluginListResult | null;
  uninstalling: boolean;
  getDetail: () => PluginsPageCatalogDetail | null;
  onChange: (detail: PluginsPageCatalogDetail | null) => void;
  showInstalled: (pluginId: string | null) => Promise<void>;
}): Promise<void> {
  const { id, gateway, context, location, inventory } = params;
  const current = params.getDetail();
  if (params.uninstalling && current?.id === id) {
    return;
  }
  const previous = current?.id === id ? current.result : null;
  if (
    previous?.detail.origin === "local" &&
    inventory &&
    !inventory.plugins.some((plugin) => plugin.id === previous.plugin.local.pluginId)
  ) {
    params.onChange(null);
    void params.showInstalled(null);
    context.replace("plugins", { pathname: pathForRoute("plugins", context.basePath) });
    return;
  }
  // Same-selection refreshes retain presentation; a new object fences older requests.
  const detail: PluginsPageCatalogDetail | null = id ? { id, result: previous, error: null } : null;
  if (current?.id !== id) {
    void params.showInstalled(null);
  }
  params.onChange(detail);
  const scope = gateway.capture();
  if (!detail || !scope) {
    return;
  }
  const installed = inventory?.plugins.find(
    (plugin) => plugin.installed && plugin.catalogId === id,
  );
  const clearInstallLink = () => {
    if (new URLSearchParams(location?.search).get("action") === "install") {
      // A link selects the plugin; installation still requires an explicit button click.
      context.replace("plugins", { pathname: location?.pathname, search: "" });
    }
  };
  if (installed) {
    // Installed identity and availability belong to the local inventory. Its
    // detail loader enriches the overview without waiting on ClawHub.
    clearInstallLink();
    await params.showInstalled(installed.id);
    return;
  }
  void params.showInstalled(null);
  try {
    const result = await loadPluginDiscoveryDetail(scope.client, detail.id);
    if (gateway.isCurrent(scope) && params.getDetail() === detail) {
      params.onChange({ ...detail, result });
      void params.showInstalled(
        result.plugin.local.installed ? (result.plugin.local.pluginId ?? null) : null,
      );
      clearInstallLink();
    }
  } catch (error) {
    if (gateway.isCurrent(scope) && params.getDetail() === detail) {
      params.onChange({ ...detail, error: formatUiError(error) });
    }
  }
}
