import { createMemo, createSignal, Errored, isPending, latest, Loading, Show } from "solid-js";
import type { PluginsSkillsReadParams } from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import { analyzeConfigSchema } from "../../components/config-form.analyze.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { WizardLogin } from "../../components/wizard-login-controller.tsx";
import { currentConfigRead } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
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
import type { PluginsPageModel } from "./plugins-page.ts";
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

export function PluginsPageView(props: { page: PluginsPageModel }) {
  const [query, setQuery] = createSignal("");
  const page = () => {
    props.page.read();
    return props.page;
  };
  const hasInventory = createMemo(() => page().state.result !== null);
  // The owner mutates in place; publish fresh props for each page revision.
  const discovery = createMemo(() => ({
    ...page().discovery.read(),
    error: page().discovery.read().error ?? page().state.error,
  }));
  const onOpenSkill = (request: PluginsSkillsReadParams) => void page().skillPreview.open(request);
  const actions = {
    openPluginSettings: (pluginId: string | null) => {
      page().context.navigate("plugin-settings", {
        pathname: pluginId
          ? pathForPluginSettings(pluginId, page().context.basePath)
          : pathForRoute("plugin-settings", page().context.basePath),
        search: "",
      });
    },
    retryConfigRead: () => {
      void page().context.runtimeConfig.refresh();
      void page().context.runtimeConfig.refreshSchema();
    },
    closeSettingsDetail: (parentRoute: "plugins" | "plugin-settings") => {
      page().setState({ detail: null, installedDetailTab: "readme" });
      page().context.navigate(parentRoute, {
        pathname: pathForRoute(parentRoute, page().context.basePath),
      });
    },
    selectInstalledDetailTab: (tab: InstalledPluginDetailTab) => {
      page().setState({ installedDetailTab: tab });
      page().context.navigate(
        page().surface === "discovery" ? "plugins" : "plugin-settings",
        pluginDetailLocation(page().routeData?.location, tab === "configuration"),
      );
    },
    selectSettingsTab: (tab: PluginSettingsTab) => {
      page().setSettingsTab(tab);
      page().context.replace("plugin-settings", {
        pathname: pathForRoute("plugin-settings", page().context.basePath),
        search: tab === "advanced" ? "?tab=advanced" : "",
      });
    },
  };
  const ask = createMemo(() => {
    page().help.update({
      connected: page().gateway.connected,
      result: page().state.result,
      detail: page().state.detail,
      catalogDetail: page().state.catalogDetail,
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
    const staticCatalog = page().state.catalogDetail?.result;
    const version = staticCatalog?.plugin.catalog.latestVersion;
    if (!staticCatalog || !version || !staticCatalog.detail.skills.length) {
      return undefined;
    }
    const onOpen = (skillName: string) =>
      onOpenSkill({ source: "catalog", catalogId: staticCatalog.plugin.id, version, skillName });
    return renderPluginSkillsSection(staticCatalog.detail.skills, onOpen);
  };
  const shared = createMemo(() => ({
    registerRemovalHeading: page().registerRemovalHeading,
    registerInstallAction: page().registerInstallAction,
    registerIcon: page().icons.register,
    connected: page().gateway.connected,
    loading: page().loading,
    result: page().state.result,
    presentedEnabled: props.page.presentedEnabled,
    error: page().state.error,
    busy: page().state.busy,
    messages: page().state.messages,
    iconUrls: page().state.iconUrls,
    iconLoading: page().icons.installed.isLoading,
    canMutate: page().canMutate(),
    mutationBlockedReason: page().accessBlockedReason(page().state.result?.mutationAllowed),
    configBusy: configState().configLoading,
    configError: configState().lastError,
    configRead: currentConfigRead(configState()),
    configSchemaRead: page().context.runtimeConfig.schemaRead,
    canEditConfig: page().canEditConfig(),
    configValue: configState().configForm,
    configHints: configState().configUiHints,
    configSchemaLoading: configState().configSchemaLoading,
    configUnsupportedPaths: configAnalysis().unsupportedPaths,
    onIconError: (pluginId: string) => page().icons.installed.handleError(pluginId),
    onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) =>
      void page().consent.mutateInstalledPlugin(pluginId, enabled ? "enable" : "disable", rowKey),
    onUninstall: (pluginId: string, rowKey: string) => void page().uninstall(pluginId, rowKey),
    onConfigPatch: (path: Array<string | number>, value: unknown) =>
      page().settings.patch(path, value),
    onConfigRemove: (path: Array<string | number>) => page().settings.patch(path, undefined),
    onConfigReload: page().reloadConfig,
    onConfigReadRetry: actions.retryConfigRead,
    onConfigWriteRetry: () => void page().context.runtimeConfig.retry(),
    onRefresh: () => void page().refreshCatalog(),
    onAskPlugin: onAskPlugin(),
    onAskSetting: ask(),
  }));

  function CatalogInventory() {
    // The route owns first-load readiness; retain accepted inventory during refresh.
    const catalogRead = createMemo(() => props.page.catalogRead());
    const loading = () => {
      latest(catalogRead);
      return page().routeLoading() || isPending(catalogRead);
    };
    return <Inventory loading={loading()} />;
  }

  function Inventory(inventoryProps: { loading: boolean }) {
    return (
      <PluginSettingsInventory
        {...shared()}
        loading={inventoryProps.loading}
        tab={page().settingsTab()}
        query={query()}
        advancedSchema={pluginAdvancedSchema(configAnalysis().schema)}
        onTabChange={actions.selectSettingsTab}
        onQueryChange={setQuery}
        pluginHref={(pluginId) => pathForPluginSettings(pluginId, page().context.basePath)}
        onOpenPlugin={(pluginId) => actions.openPluginSettings(pluginId)}
      />
    );
  }

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
        installProgress={page().consent.getActiveInstall(pluginRowKey(detailProps.pluginId))}
        inspection={page().state.detail?.inspection ?? null}
        mcpLoginBusy={page().mcpLogin.busy}
        canMcpLogin={canCallGatewayMethod(
          page().gateway.snapshot,
          "mcp.authLogin",
          "operator.admin",
        )}
        onMcpLogin={(serverName) => void page().mcpLogin.start(serverName)}
        onEditMcp={() => page().context.navigate("mcp")}
        catalog={page().state.detail?.catalog}
        inspectionRead={page().inspectionRead}
        catalogLoading={page().state.detail?.catalogLoading}
        catalogIconUrls={page().state.catalogIconUrls}
        catalogIconLoading={page().icons.catalog.isLoading}
        resolveCredential={page().settings.resolveCredential}
        tools={page().state.detail?.tools}
        onOpenTool={(name) =>
          page().skillPreview.openTool(
            page().state.detail?.tools?.find((entry) => entry.name === name) ?? { name },
          )
        }
        skillsSection={
          skills().length
            ? renderPluginSkillsSection(skills(), (skillName) =>
                onOpenSkill({
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
            page().closeCatalogDetail();
          } else {
            actions.closeSettingsDetail(settingsParentRoute());
          }
        }}
        onRetryInspection={() => void page().showDetails(detailProps.pluginId)}
        onTabChange={actions.selectInstalledDetailTab}
      />
    );
  }

  return (
    <>
      {page().surface === "discovery" && !page().state.catalogDetail && (
        <PluginsHubHeader
          active="plugins"
          onSelect={(tab: PluginsHubTab) => {
            if (tab !== "plugins" || page().surface !== "discovery") {
              page().context.navigate(tab);
            }
          }}
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
          <div id={PLUGINS_HUB_PANEL_ID} role="tabpanel" aria-labelledby="plugins-tab-plugins">
            {page().state.catalogDetail ? (
              detailPluginId() && !page().consent.getActiveInstall(`install:${catalogId()}`) ? (
                <InstalledDetail pluginId={detailPluginId()!} />
              ) : (
                <PluginCatalogDetail
                  registerRemovalHeading={page().registerRemovalHeading}
                  registerInstallAction={page().registerInstallAction}
                  registerIcon={page().icons.register}
                  onAskPlugin={onAskPlugin()}
                  connected={page().gateway.connected}
                  skillsSection={catalogSkillsSection()}
                  result={page().state.catalogDetail?.result ?? null}
                  read={page().detailRead}
                  backHref={pathForRoute("plugins", page().context.basePath)}
                  onBack={() => page().closeCatalogDetail()}
                  onRetry={() =>
                    void page().showCatalogDetail(page().state.catalogDetail?.id ?? null)
                  }
                  canInstall={
                    page().canMutate() &&
                    !page().state.messages[`install:${catalogId()}`]?.savedInstall &&
                    catalogInstallable()
                  }
                  installBlockedReason={page().accessBlockedReason(
                    page().state.result?.mutationAllowed,
                  )}
                  onInstall={() => void page().installCatalogEntry(catalogId())}
                  busy={Boolean(page().state.busy[`install:${catalogId()}`])}
                  installProgress={page()
                    .consent.read()
                    .installProgress.get(`install:${catalogId()}`)}
                  message={page().state.messages[`install:${catalogId()}`]}
                  onContinueInstall={(request) =>
                    void page().consent.install(request, `install:${catalogId()}`)
                  }
                  iconUrls={page().state.catalogIconUrls}
                  iconLoading={page().icons.catalog.isLoading}
                />
              )
            ) : (
              <SettingsPage wide carapace>
                <PluginCatalogResults
                  registerInstallAction={page().registerInstallAction}
                  {...discovery()}
                  registerIcon={page().icons.register}
                  connected={page().gateway.connected}
                  onRetryCategories={() => void page().discovery.ensureCategories(true)}
                  iconUrls={page().state.catalogIconUrls}
                  pluginIconUrls={page().state.iconUrls}
                  iconLoading={page().icons.catalog.isLoading}
                  pluginIconLoading={page().icons.installed.isLoading}
                  canInstall={page().canMutate()}
                  installProgress={page().consent.read().installProgress}
                  inventory={page().state.result?.plugins}
                  entryHref={(id) => pathForPluginCatalogEntry(id, page().context.basePath)}
                  onIntentChange={(intent) => void page().discovery.selectIntent(intent)}
                  onCategoryChange={(category) => void page().discovery.selectCategory(category)}
                  onQueryChange={(nextQuery) => page().discovery.updateQuery(nextQuery)}
                  onOpenEntry={(id) =>
                    page().context.navigate("plugins", {
                      pathname: pathForPluginCatalogEntry(id, page().context.basePath),
                    })
                  }
                  onInstall={(id) => void page().installCatalogEntry(id)}
                  busy={page().state.busy}
                  messages={page().state.messages}
                  onContinueInstall={(id, request) =>
                    void page().consent.install(request, `install:${id}`)
                  }
                  onLoadMore={() => void page().discovery.loadMore()}
                  onRetry={() => void page().discovery.refresh()}
                />
              </SettingsPage>
            )}
          </div>
        ) : detailPluginId() ? (
          <InstalledDetail pluginId={detailPluginId()!} />
        ) : (
          <Errored
            fallback={(error, reset) => (
              <div
                class="callout danger plugins-settings-error oc-banner oc-banner-error"
                role="alert"
              >
                <span>{formatUiError(error())}</span>
                <button
                  type="button"
                  class="btn btn--sm oc-action oc-action-secondary"
                  onClick={() => {
                    void page().refreshCatalog();
                    reset();
                  }}
                >
                  {t("pluginsPage.tryAgain")}
                </button>
              </div>
            )}
          >
            <Show when={hasInventory()} fallback={<Inventory loading={page().loading} />}>
              <Loading fallback={<Inventory loading={true} />}>
                <CatalogInventory />
              </Loading>
            </Show>
          </Errored>
        )}
      </SettingsWorkspace>
      <PluginSkillPreview preview={page().skillPreview} state={page().skillPreview.state} />
      <WizardLogin controller={props.page.mcpLogin.dialog} />
      <Show when={page().consent.read().consent}>
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
              registerIcon={page().icons.register}
              consent={consent()}
              inspection={page().consent.read().inspection}
              inspectionRead={page().consent.read().inspectionRead}
              loading={page().consent.read().inspectionLoading}
              error={page().consent.read().inspectionError}
              iconUrl={icon().url}
              iconLoading={icon().loading}
              canMutate={page().canMutate()}
              mutationBlockedReason={page().accessBlockedReason(
                page().state.result?.mutationAllowed,
              )}
              busy={page().mutationSaving() || Object.values(page().state.busy).some(Boolean)}
              onCancel={() => page().consent.close()}
              onConfirm={() => page().consent.confirm()}
              onRetry={() => void page().consent.inspect()}
            />
          );
        }}
      </Show>
    </>
  );
}
