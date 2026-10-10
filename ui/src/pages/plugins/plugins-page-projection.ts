import { pathForPluginSettings, pathForRoute } from "../../app-route-paths.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { pluginDetailLocation } from "./detail-tabs.ts";
import type { PluginsPageViewModel } from "./plugins-page-view.tsx";
import type { PluginsPageController } from "./plugins-page.tsx";
export function createPluginsPageProjection(page: PluginsPageController): PluginsPageViewModel {
  return {
    get mcpLogin() {
      page.track();
      return page.mcpLogin.render();
    },
    get mcpLoginBusy() {
      page.track();
      return page.mcpLogin.busy;
    },
    get canMcpLogin() {
      page.track();
      return canCallGatewayMethod(page.gateway.snapshot, "mcp.authLogin", "operator.admin");
    },
    get help() {
      page.track();
      return page.help;
    },
    get context() {
      page.track();
      return page.context;
    },
    get routeData() {
      page.track();
      return page.routeData;
    },
    get surface() {
      page.track();
      return page.surface;
    },
    get connected() {
      page.track();
      return page.gateway.connected;
    },
    get loading() {
      page.track();
      return page.loading;
    },
    get result() {
      page.track();
      return page.state.result;
    },
    get error() {
      page.track();
      return page.state.error;
    },
    get query() {
      page.track();
      return page.state.query;
    },
    get settingsTab() {
      page.track();
      return page.state.settingsTab;
    },
    get busy() {
      page.track();
      return page.state.busy;
    },
    get messages() {
      page.track();
      return page.state.messages;
    },
    get detail() {
      page.track();
      return page.state.detail;
    },
    get pageNotice() {
      page.track();
      return page.state.pageNotice;
    },
    get iconUrls() {
      page.track();
      return page.state.iconUrls;
    },
    get catalogIconUrls() {
      page.track();
      return page.state.catalogIconUrls;
    },
    get iconLoading() {
      page.track();
      return page.icons.installed.isLoading;
    },
    get catalogIconLoading() {
      page.track();
      return page.icons.catalog.isLoading;
    },
    get catalogDetail() {
      page.track();
      return page.state.catalogDetail;
    },
    get installedDetailTab() {
      page.track();
      return page.state.installedDetailTab;
    },
    get canMutate() {
      page.track();
      return page.canMutate();
    },
    get mutationBlockedReason() {
      page.track();
      return page.accessBlockedReason(page.state.result?.mutationAllowed);
    },
    get canEditConfig() {
      page.track();
      return page.canEditConfig();
    },
    get discovery() {
      page.track();
      return page.discovery;
    },
    get consentController() {
      page.track();
      return page.consentController;
    },
    get resolveCredential() {
      page.track();
      return page.settings.resolveCredential;
    },
    get skillPreview() {
      page.track();
      return page.skillPreview;
    },
    actions: {
      startMcpLogin: (serverName) => void page.mcpLogin.start(serverName),
      selectHubTab: (tab) => page.selectHubTab(tab),
      closeCatalogDetail: () => page.closeCatalogDetail(),
      retryCatalogDetail: () => void page.showCatalogDetail(page.state.catalogDetail?.id ?? null),
      installCatalogEntry: (id) => void page.installCatalogEntry(id),
      openSkill: (request) => void page.skillPreview.open(request),
      openTool: (name) =>
        page.skillPreview.openTool(
          page.state.detail?.tools?.find((entry) => entry.name === name) ?? { name },
        ),
      setQuery: (query) => {
        page.setState({ query });
      },
      refreshCatalog: () => void page.refreshCatalog(),
      openPluginSettings: (pluginId) => {
        page.context.navigate("plugin-settings", {
          pathname: pluginId
            ? pathForPluginSettings(pluginId, page.context.basePath)
            : pathForRoute("plugin-settings", page.context.basePath),
          search: "",
        });
      },
      handlePluginIconError: (pluginId) => page.icons.installed.handleError(pluginId),
      updateEnabled: (pluginId, enabled, rowKey) =>
        void page.consentController.mutateInstalledPlugin(
          pluginId,
          enabled ? "enable" : "disable",
          rowKey,
        ),
      uninstall: (pluginId, rowKey) => void page.uninstall(pluginId, rowKey),
      patchConfig: (path, value) => page.settings.patch(path, value),
      removeConfig: (path) => page.settings.patch(path, undefined),
      reloadConfig: () => {
        page.pluginConfigEditPending = false;
        const runtimeConfig = page.context.runtimeConfig;
        void runtimeConfig
          .discardDraft({ reloadOnly: true })
          .then(() => runtimeConfig.ensureSchemaLoaded());
      },
      retryConfigRead: () => {
        void page.context.runtimeConfig.refresh();
        void page.context.runtimeConfig.refreshSchema();
      },
      retryConfigWrite: () => {
        void page.context.runtimeConfig.retry();
      },
      closeSettingsDetail: (parentRoute) => {
        page.setState({ detail: null });
        page.setState({ installedDetailTab: "readme" });
        page.context.navigate(parentRoute, {
          pathname: pathForRoute(parentRoute, page.context.basePath),
        });
      },
      retrySettingsDetail: (pluginId) => void page.showDetails(pluginId),
      selectInstalledDetailTab: (tab) => {
        page.setState({ installedDetailTab: tab });
        page.context.navigate(
          page.surface === "discovery" ? "plugins" : "plugin-settings",
          pluginDetailLocation(page.routeData?.location, tab === "configuration"),
        );
      },
      selectSettingsTab: (tab) => {
        page.setState({ settingsTab: tab });
        page.context.replace("plugin-settings", {
          pathname: pathForRoute("plugin-settings", page.context.basePath),
          search: tab === "advanced" ? "?tab=advanced" : "",
        });
      },
    },
  };
}
