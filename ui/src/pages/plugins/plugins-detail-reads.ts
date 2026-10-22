import { createMemo, createSignal, type Accessor } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { pluginRowKey } from "./plugin-row-message.tsx";
import { loadInstalledPluginDetail, loadPluginCatalogDetail } from "./plugins-detail-loader.ts";
import type { createPluginsPageState } from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";

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
  function showDetails(pluginId: string | null) {
    inspection.reset();
    options.selectInstalled(pluginId);
    return loadInstalledPluginDetail({
      pluginId,
      plugin: state.result?.plugins.find((entry) => entry.id === pluginId),
      catalog: state.catalogDetail?.result,
      gateway: options.gateway(),
      canInspect: !pluginId || state.busy[pluginRowKey(pluginId)] !== "uninstall",
      getDetail: () => state.detail,
      onChange: (detail) => setState({ detail }),
      onRead: inspection.observe,
    });
  }
  function showCatalogDetail(id: string | null) {
    catalog.reset();
    if (options.surface() !== "discovery") {
      setState({ catalogDetail: null });
      return Promise.resolve();
    }
    return loadPluginCatalogDetail({
      id,
      gateway: options.gateway(),
      context: options.context,
      location: options.routeData()?.location,
      inventory: state.result,
      uninstalling: options.uninstalling(),
      getDetail: () => state.catalogDetail,
      onChange: (catalogDetail) => setState({ catalogDetail }),
      onRead: catalog.observe,
      showInstalled: showDetails,
    });
  }
  return { inspection, catalog, showDetails, showCatalogDetail };
}
