import { createMemo, Show } from "solid-js";
import type { PluginsSkillsReadParams } from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import { analyzeConfigSchema } from "../../components/config-form.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { renderPluginCatalogDetail as PluginCatalogDetail } from "./catalog-detail.tsx";
import { renderPluginCatalogResults as PluginCatalogResults } from "./catalog-results.tsx";
import { renderPluginConsentDialog as PluginConsentDialog } from "./consent-dialog.tsx";
import "./custom-elements.ts";
import { pluginDetailLocation, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import {
  pluginRowKey,
  renderPluginRowMessage as PluginRowMessageView,
} from "./plugin-row-message.tsx";
import { PluginsHubHeader } from "./plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
import { installRequestForDiscoveryDetail } from "./plugins-page-model.ts";
import type { PluginsPageController } from "./plugins-page.ts";
import {
  pluginAdvancedSchema,
  pluginConfigSchema,
  pluginHostControlsSchema,
} from "./settings-model.ts";
import {
  renderPluginSettingsDetail as PluginSettingsDetail,
  renderPluginSettingsInventory as PluginSettingsInventory,
  type PluginSettingsTab,
} from "./settings-view.tsx";
import { PluginSkillPreview, renderPluginSkillsSection } from "./skill-preview.tsx";

type PluginsPageViewActions = {
  startMcpLogin: (serverName: string) => void;
  openTool: (name: string) => void;
  openSkill: (request: PluginsSkillsReadParams) => void;
  selectHubTab: (tab: PluginsHubTab) => void;
  closeCatalogDetail: () => void;
  retryCatalogDetail: () => void;
  installCatalogEntry: (id: string) => void;
  setQuery: (query: string) => void;
  refreshCatalog: () => void;
  openPluginSettings: (pluginId: string | null) => void;
  handlePluginIconError: (pluginId: string) => void;
  updateEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  uninstall: (pluginId: string, rowKey: string) => void;
  patchConfig: (path: Array<string | number>, value: unknown) => boolean | void;
  removeConfig: (path: Array<string | number>) => boolean | void;
  reloadConfig: () => void;
  retryConfigRead: () => void;
  retryConfigWrite: () => void;
  closeSettingsDetail: (parentRoute: "plugins" | "plugin-settings") => void;
  retrySettingsDetail: (pluginId: string) => void;
  selectInstalledDetailTab: (tab: InstalledPluginDetailTab) => void;
  selectSettingsTab: (tab: PluginSettingsTab) => void;
};

export function PluginsPageView(props: { page: PluginsPageController; revision: () => number }) {
  const page = () => {
    props.revision();
    return props.page;
  };
  const actions: PluginsPageViewActions = {
    startMcpLogin: (serverName) => void page().mcpLogin.start(serverName),
    selectHubTab: (tab) => page().selectHubTab(tab),
    closeCatalogDetail: () => page().closeCatalogDetail(),
    retryCatalogDetail: () => void page().showCatalogDetail(page().state.catalogDetail?.id ?? null),
    installCatalogEntry: (id) => void page().installCatalogEntry(id),
    openSkill: (request) => void page().skillPreview.open(request),
    openTool: (name) =>
      page().skillPreview.openTool(
        page().state.detail?.tools?.find((entry) => entry.name === name) ?? { name },
      ),
    setQuery: (query) => {
      page().setState({ query });
    },
    refreshCatalog: () => void page().refreshCatalog(),
    openPluginSettings: (pluginId) => {
      page().context.navigate("plugin-settings", {
        pathname: pluginId
          ? pathForPluginSettings(pluginId, page().context.basePath)
          : pathForRoute("plugin-settings", page().context.basePath),
        search: "",
      });
    },
    handlePluginIconError: (pluginId) => page().icons.installed.handleError(pluginId),
    updateEnabled: (pluginId, enabled, rowKey) =>
      void page().consentController.mutateInstalledPlugin(
        pluginId,
        enabled ? "enable" : "disable",
        rowKey,
      ),
    uninstall: (pluginId, rowKey) => void page().uninstall(pluginId, rowKey),
    patchConfig: (path, value) => page().settings.patch(path, value),
    removeConfig: (path) => page().settings.patch(path, undefined),
    reloadConfig: () => {
      page().pluginConfigEditPending = false;
      const runtimeConfig = page().context.runtimeConfig;
      void runtimeConfig
        .discardDraft({ reloadOnly: true })
        .then(() => runtimeConfig.ensureSchemaLoaded());
    },
    retryConfigRead: () => {
      void page().context.runtimeConfig.refresh();
      void page().context.runtimeConfig.refreshSchema();
    },
    retryConfigWrite: () => {
      void page().context.runtimeConfig.retry();
    },
    closeSettingsDetail: (parentRoute) => {
      page().setState({ detail: null });
      page().setState({ installedDetailTab: "readme" });
      page().context.navigate(parentRoute, {
        pathname: pathForRoute(parentRoute, page().context.basePath),
      });
    },
    retrySettingsDetail: (pluginId) => void page().showDetails(pluginId),
    selectInstalledDetailTab: (tab) => {
      page().setState({ installedDetailTab: tab });
      page().context.navigate(
        page().surface === "discovery" ? "plugins" : "plugin-settings",
        pluginDetailLocation(page().routeData?.location, tab === "configuration"),
      );
    },
    selectSettingsTab: (tab) => {
      page().setState({ settingsTab: tab });
      page().context.replace("plugin-settings", {
        pathname: pathForRoute("plugin-settings", page().context.basePath),
        search: tab === "advanced" ? "?tab=advanced" : "",
      });
    },
  };
  const ask = createMemo(() => {
    page().help.update({
      context: page().context,
      connected: page().gateway.connected,
      result: page().state.result,
      detail: page().state.detail,
      catalogDetail: page().state.catalogDetail,
      installedDetailTab: page().state.installedDetailTab,
    });
    return page().help?.available ? page().help.ask : undefined;
  });
  const onAskPlugin = createMemo(() => {
    const staticAsk = ask();
    return staticAsk ? () => void staticAsk() : undefined;
  });
  const configState = () => page().context.runtimeConfig.state;
  const configAnalysis = createMemo(() => analyzeConfigSchema(configState().configSchema));
  const detailPluginId = () => page().state.detail?.pluginId;
  const catalogId = () => page().state.catalogDetail?.id ?? "";
  const catalogInstallable = createMemo(() => {
    const result = page().state.catalogDetail?.result;
    return Boolean(result && installRequestForDiscoveryDetail(result));
  });
  const settingsParentRoute = () =>
    new URLSearchParams(page().routeData?.location.search ?? "").get("from") === "plugins"
      ? ("plugins" as const)
      : ("plugin-settings" as const);
  const catalogSkillsSection = () => {
    const catalog = page().state.catalogDetail?.result;
    const version = catalog?.plugin.catalog.latestVersion;
    const openSkill = actions.openSkill;
    return catalog && version && catalog.detail.skills.length
      ? renderPluginSkillsSection(catalog.detail.skills, (skillName) =>
          openSkill({
            source: "catalog",
            catalogId: catalog.plugin.id,
            version,
            skillName,
          }),
        )
      : undefined;
  };
  const shared = createMemo(() => ({
    connected: page().gateway.connected,
    loading: page().loading,
    result: page().state.result,
    error: page().state.error,
    busy: page().state.busy,
    messages: page().state.messages,
    iconUrls: page().state.iconUrls,
    iconLoading: page().icons.installed.isLoading,
    canMutate: page().canMutate(),
    mutationBlockedReason: page().accessBlockedReason(page().state.result?.mutationAllowed),
    configBusy: configState().configLoading,
    configError: configState().lastError,
    canEditConfig: page().canEditConfig(),
    configValue: configState().configForm,
    configHints: configState().configUiHints,
    configSchemaLoading: configState().configSchemaLoading,
    configUnsupportedPaths: configAnalysis().unsupportedPaths,
    onIconError: actions.handlePluginIconError,
    onSetEnabled: actions.updateEnabled,
    onUninstall: actions.uninstall,
    onConfigPatch: actions.patchConfig,
    onConfigRemove: actions.removeConfig,
    onConfigReload: actions.reloadConfig,
    onConfigReadRetry: actions.retryConfigRead,
    onConfigWriteRetry: actions.retryConfigWrite,
    onRefresh: actions.refreshCatalog,
    onAskPlugin: onAskPlugin(),
    onAskSetting: ask(),
  }));

  function InstalledDetail(detailProps: { pluginId: string }) {
    const components = () => page().state.detail?.inspection?.components;
    const skills = createMemo(
      () => components()?.skillDetails ?? components()?.skills.map((name) => ({ name })) ?? [],
    );
    const settings = () => page().state.installedDetailTab === "configuration";
    const settingsLocation = () => pluginDetailLocation(page().routeData?.location, true);
    const overviewLocation = () => pluginDetailLocation(page().routeData?.location, false);
    return (
      <PluginSettingsDetail
        {...shared()}
        pluginId={detailProps.pluginId}
        installProgress={page().consentController.getActiveInstall(
          pluginRowKey(detailProps.pluginId),
        )}
        inspection={page().state.detail?.inspection ?? null}
        mcpLoginBusy={page().mcpLogin.busy}
        canMcpLogin={canCallGatewayMethod(
          page().gateway.snapshot,
          "mcp.authLogin",
          "operator.admin",
        )}
        onMcpLogin={actions.startMcpLogin}
        onEditMcp={() => page().context.navigate("mcp")}
        catalog={page().state.detail?.catalog}
        inspectionError={page().state.detail?.error ?? null}
        catalogLoading={page().state.detail?.catalogLoading}
        catalogIconUrls={page().state.catalogIconUrls}
        catalogIconLoading={page().icons.catalog.isLoading}
        resolveCredential={page().settings.resolveCredential}
        tools={page().state.detail?.tools}
        onOpenTool={actions.openTool}
        skillsSection={
          skills().length
            ? renderPluginSkillsSection(skills(), (skillName) =>
                actions.openSkill({
                  source: "installed",
                  pluginId: detailProps.pluginId,
                  skillName,
                }),
              )
            : !components()
              ? catalogSkillsSection()
              : undefined
        }
        settingsHref={`${settingsLocation().pathname ?? ""}${settingsLocation().search}`}
        configSchema={pluginConfigSchema(configAnalysis().schema, detailProps.pluginId)}
        hostControlsSchema={pluginHostControlsSchema(configAnalysis().schema, detailProps.pluginId)}
        backHref={
          settings()
            ? `${overviewLocation().pathname ?? ""}${overviewLocation().search}`
            : pathForRoute(
                page().surface === "discovery" ? "plugins" : settingsParentRoute(),
                page().context.basePath,
              )
        }
        backLabel={
          page().surface === "discovery" || settingsParentRoute() === "plugins"
            ? t("tabs.plugins")
            : t("nav.settings")
        }
        tab={page().state.installedDetailTab}
        onBack={() => {
          if (settings()) {
            actions.selectInstalledDetailTab("readme");
          } else if (page().surface === "discovery") {
            actions.closeCatalogDetail();
          } else {
            actions.closeSettingsDetail(settingsParentRoute());
          }
        }}
        onRetryInspection={() => actions.retrySettingsDetail(detailProps.pluginId)}
        onTabChange={actions.selectInstalledDetailTab}
      />
    );
  }

  return (
    <>
      {page().surface === "discovery" && !page().state.catalogDetail && (
        <PluginsHubHeader
          active="plugins"
          onSelect={actions.selectHubTab}
          secondaryAction={{
            label: t("pluginsPage.pluginSettings"),
            icon: <Icon name="settings" />,
            onClick: () => actions.openPluginSettings(null),
          }}
        />
      )}
      <SettingsWorkspace>
        {PluginRowMessageView(page().state.pageNotice ?? undefined)}
        {page().surface === "discovery" ? (
          <wa-tab-panel
            id={PLUGINS_HUB_PANEL_ID}
            name="plugins"
            prop:active={true}
            aria-labelledby="plugins-tab-plugins"
          >
            {page().state.catalogDetail ? (
              detailPluginId() &&
              !page().consentController.getActiveInstall(`install:${catalogId()}`) ? (
                <InstalledDetail pluginId={detailPluginId()!} />
              ) : (
                <PluginCatalogDetail
                  onAskPlugin={onAskPlugin()}
                  connected={page().gateway.connected}
                  skillsSection={catalogSkillsSection()}
                  result={page().state.catalogDetail?.result ?? null}
                  error={page().state.catalogDetail?.error ?? null}
                  backHref={pathForRoute("plugins", page().context.basePath)}
                  onBack={actions.closeCatalogDetail}
                  onRetry={actions.retryCatalogDetail}
                  canInstall={
                    page().canMutate() &&
                    !page().state.messages[`install:${catalogId()}`]?.savedInstall &&
                    catalogInstallable()
                  }
                  installBlockedReason={page().accessBlockedReason(
                    page().state.result?.mutationAllowed,
                  )}
                  onInstall={() => actions.installCatalogEntry(catalogId())}
                  busy={Boolean(page().state.busy[`install:${catalogId()}`])}
                  installProgress={page().consentController.installProgress.get(
                    `install:${catalogId()}`,
                  )}
                  message={page().state.messages[`install:${catalogId()}`]}
                  onContinueInstall={(request) =>
                    void page().consentController.install(request, `install:${catalogId()}`)
                  }
                  iconUrls={page().state.catalogIconUrls}
                  iconLoading={page().icons.catalog.isLoading}
                />
              )
            ) : (
              <SettingsPage wide carapace>
                <PluginCatalogResults
                  connected={page().gateway.connected}
                  loading={page().discovery.loading}
                  result={page().discovery.result}
                  error={page().discovery.error ?? page().state.error}
                  remoteError={page().discovery.remoteError}
                  categories={page().discovery.categories}
                  categoriesLoading={page().discovery.categoriesLoading}
                  categoriesError={page().discovery.categoriesError}
                  onRetryCategories={() => void page().discovery.ensureCategories(true)}
                  featured={page().discovery.featured}
                  trending={page().discovery.trending}
                  loadingMore={page().discovery.loadingMore}
                  loadMoreError={page().discovery.loadMoreError}
                  intent={page().discovery.intent}
                  category={page().discovery.category}
                  query={page().discovery.query}
                  iconUrls={page().state.catalogIconUrls}
                  pluginIconUrls={page().state.iconUrls}
                  iconLoading={page().icons.catalog.isLoading}
                  pluginIconLoading={page().icons.installed.isLoading}
                  canInstall={page().canMutate()}
                  installProgress={page().consentController.installProgress}
                  entryHref={(id) => pathForPluginCatalogEntry(id, page().context.basePath)}
                  onIntentChange={(intent) => page().discovery.selectIntent(intent)}
                  onCategoryChange={(category) => page().discovery.selectCategory(category)}
                  onQueryChange={(query) => page().discovery.updateQuery(query)}
                  onOpenEntry={(id) =>
                    page().context.navigate("plugins", {
                      pathname: pathForPluginCatalogEntry(id, page().context.basePath),
                    })
                  }
                  onInstall={actions.installCatalogEntry}
                  busy={page().state.busy}
                  messages={page().state.messages}
                  onContinueInstall={(id, request) =>
                    void page().consentController.install(request, `install:${id}`)
                  }
                  onLoadMore={() => void page().discovery.loadMore()}
                  onRetry={() => void page().discovery.refresh()}
                />
              </SettingsPage>
            )}
          </wa-tab-panel>
        ) : detailPluginId() ? (
          <InstalledDetail pluginId={detailPluginId()!} />
        ) : (
          <PluginSettingsInventory
            {...shared()}
            tab={page().state.settingsTab}
            query={page().state.query}
            advancedSchema={pluginAdvancedSchema(configAnalysis().schema)}
            onTabChange={actions.selectSettingsTab}
            onQueryChange={actions.setQuery}
            pluginHref={(pluginId) => pathForPluginSettings(pluginId, page().context.basePath)}
            onOpenPlugin={(pluginId) => actions.openPluginSettings(pluginId)}
          />
        )}
      </SettingsWorkspace>
      <PluginSkillPreview controller={page().skillPreview} state={page().skillPreview.state} />
      <LitContent render={() => page().mcpLogin.render()} />
      <Show when={page().consentController.consent}>
        {(consent) => {
          const icon = createMemo(() => {
            const pluginId = consent().pluginId;
            return {
              url: pluginId ? page().state.iconUrls[pluginId] : undefined,
              loading: Boolean(pluginId && page().icons.installed.isLoading(pluginId)),
            };
          });
          return (
            <PluginConsentDialog
              consent={consent()}
              inspection={page().consentController.inspection}
              loading={page().consentController.inspectionLoading}
              error={page().consentController.inspectionError}
              iconUrl={icon().url}
              iconLoading={icon().loading}
              canMutate={page().canMutate()}
              mutationBlockedReason={page().accessBlockedReason(
                page().state.result?.mutationAllowed,
              )}
              busy={Object.values(page().state.busy).some(Boolean)}
              onCancel={() => page().consentController.close()}
              onConfirm={() => page().consentController.confirm()}
              onRetry={() => void page().consentController.inspect()}
            />
          );
        }}
      </Show>
    </>
  );
}
