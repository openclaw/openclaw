import { createMemo, createSignal, type Accessor } from "solid-js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import { loadPluginDiscoveryDetail } from "../../lib/plugins/index.ts";
import { pluginRowKey } from "./plugin-row-message.tsx";
import type {
  createPluginsPageState,
  PluginsPageCatalogDetail,
  PluginsPageDetail,
} from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginToolPreview } from "./tool-preview.tsx";

type ReadReceipt = { result: Promise<unknown> };
export type PluginDetailRead = { receipt: Accessor<ReadReceipt | null>; value: Accessor<null> };

function createRead() {
  const [receipt, setReceipt] = createSignal<ReadReceipt | null>(null, { ownedWrite: true });
  const value = createMemo(async () => {
    await receipt()?.result;
    return null;
  });
  let retire = () => {};
  const reset = () => {
    retire();
    setReceipt(null);
  };
  return {
    receipt,
    value,
    reset,
    release: () => retire(),
    observe: (result: Promise<unknown>) => {
      reset();
      // Selection and connection owners release the view before a retired transport settles.
      const lifetime = Promise.withResolvers<void>();
      retire = lifetime.resolve;
      const completion = Promise.race([result, lifetime.promise]);
      void completion.catch(() => {});
      setReceipt({ result: completion });
    },
  };
}

export function createPluginDetailReads(options: {
  state: ReturnType<typeof createPluginsPageState>;
  setState: (patch: Partial<ReturnType<typeof createPluginsPageState>>) => void;
  gateway: () => GatewayPageBinding;
  context: ApplicationContext;
  surface: () => "discovery" | "settings";
  routeData: () => PluginsRouteData | undefined;
  uninstalling: () => boolean;
  selectInstalled: (pluginId: string | null) => void;
}) {
  const inspection = createRead();
  const catalog = createRead();
  const { state, setState } = options;
  /** Local inspection owns availability; optional metadata never delays the installed controls. */
  async function showDetails(pluginId: string | null): Promise<void> {
    inspection.reset();
    options.selectInstalled(pluginId);
    const plugin = state.result?.plugins.find((entry) => entry.id === pluginId);
    const cachedCatalog = state.catalogDetail?.result;
    const gateway = options.gateway();
    const canInspect = !pluginId || state.busy[pluginRowKey(pluginId)] !== "uninstall";
    const current = state.detail;
    const previous = current?.pluginId === pluginId ? current : null;
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
        }
      : null;
    setState({ detail: initial });
    const scope = gateway.capture();
    if (!plugin?.installed || !initial || !scope || !canInspect) {
      return;
    }
    const { client } = scope;
    // A new detail snapshot retires this read, including when uninstall pauses inspection.
    let ownedDetail: PluginsPageDetail = initial;
    const isCurrent = () => gateway.isCurrent(scope) && state.detail === ownedDetail;
    const publish = (patch: Partial<PluginsPageDetail>) => {
      if (!isCurrent()) {
        return;
      }
      ownedDetail = { ...ownedDetail, ...patch };
      setState({ detail: ownedDetail });
    };
    const tools =
      isGatewayMethodAdvertised({ hello: gateway.snapshot?.hello }, "tools.catalog") === true
        ? client
            .request<ToolsCatalogResult>("tools.catalog", { includePlugins: true })
            .catch(() => undefined)
        : Promise.resolve(undefined);
    try {
      const read = inspectPlugin(client, plugin.id);
      inspection.observe(read);
      const inspected = await read;
      if (!isCurrent()) {
        return;
      }
      publish({
        inspection: inspected,
        tools: undefined,
        catalog: inspected.catalog ?? initial.catalog,
        catalogLoading: Boolean(plugin.catalogId && !inspected.catalog && !initial.catalog),
      });
      void tools.then((toolCatalog) => {
        if (!toolCatalog) {
          return;
        }
        const toolDetails = new Map<string, PluginToolPreview>(
          inspected.declared.tools.map((name) => [name, { name }]),
        );
        for (const group of toolCatalog.groups.filter((entry) => entry.pluginId === plugin.id)) {
          for (const tool of group.tools) {
            toolDetails.set(tool.id, {
              name: tool.id,
              description: tool.fullDescription ?? tool.description,
              parameters: tool.parameters,
            });
          }
        }
        publish({ tools: [...toolDetails.values()] });
      });
      if (!plugin.catalogId) {
        return;
      }
      try {
        const catalogDetail = await loadPluginDiscoveryDetail(
          client,
          plugin.catalogId,
          undefined,
          plugin.version,
        );
        publish({ catalog: catalogDetail, catalogLoading: false });
      } catch {
        // Remote enrichment is optional; settle its placeholder without hiding local controls.
        publish({ catalogLoading: false });
      }
    } catch {
      // The admitted read receipt presents failures without discarding accepted inspection.
    }
  }
  /** Reconcile the selected catalog identity against authoritative local inventory. */
  async function showCatalogDetail(id: string | null): Promise<void> {
    catalog.reset();
    if (options.surface() !== "discovery") {
      setState({ catalogDetail: null });
      return;
    }
    const gateway = options.gateway();
    const context = options.context;
    const location = options.routeData()?.location;
    const inventory = state.result;
    const uninstalling = options.uninstalling();
    const current = state.catalogDetail;
    if (uninstalling && current?.id === id) {
      return;
    }
    const previous = current?.id === id ? current.result : null;
    if (
      previous?.detail.origin === "local" &&
      previous.plugin.local.installed &&
      inventory &&
      !inventory.plugins.some((plugin) => plugin.id === previous.plugin.local.pluginId)
    ) {
      setState({ catalogDetail: null });
      void showDetails(null);
      context.replace("plugins", { pathname: pathForRoute("plugins", context.basePath) });
      return;
    }
    const detail: PluginsPageCatalogDetail | null = id ? { id, result: previous } : null;
    if (current?.id !== id) {
      void showDetails(null);
    }
    setState({ catalogDetail: detail });
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
      await showDetails(installed.id);
      return;
    }
    void showDetails(null);
    try {
      const read = loadPluginDiscoveryDetail(scope.client, detail.id);
      catalog.observe(read);
      const result = await read;
      if (gateway.isCurrent(scope) && state.catalogDetail === detail) {
        setState({ catalogDetail: { ...detail, result } });
        void showDetails(
          result.plugin.local.installed ? (result.plugin.local.pluginId ?? null) : null,
        );
        clearInstallLink();
      }
    } catch {
      // The admitted read receipt presents this failure; keep the accepted result.
    }
  }
  return { inspection, catalog, showDetails, showCatalogDetail };
}
