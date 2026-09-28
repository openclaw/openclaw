import { html, nothing } from "lit";
import type { PluginsSkillsReadParams } from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { analyzeConfigSchema } from "../../components/config-form.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail } from "./catalog-detail.ts";
import { renderPluginCatalogResults } from "./catalog-results.ts";
import { renderPluginConsentDialog } from "./consent-dialog.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import type { PluginHelpController } from "./plugin-help-controller.ts";
import {
  pluginRowKey,
  renderPluginRowMessage,
  type PluginRowMessage,
} from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";
import { renderPluginsHubHeader } from "./plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
import {
  installRequestForDiscoveryDetail,
  type PluginMutationAction,
  type PluginsPageCatalogDetail,
  type PluginsPageDetail,
} from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsEditor } from "./settings-editor.ts";
import {
  pluginAdvancedSchema,
  pluginConfigSchema,
  pluginHostControlsSchema,
} from "./settings-model.ts";
import {
  renderPluginSettingsDetail,
  renderPluginSettingsInventory,
  type PluginSettingsTab,
} from "./settings-view.ts";
import {
  renderPluginSkillPreview,
  renderPluginSkillsSection,
  type PluginPreviewController,
} from "./skill-preview.ts";

type PluginsPageViewActions = {
  openTool: (name: string) => void;
  openSkill: (request: PluginsSkillsReadParams) => void;
  selectHubTab: (tab: PluginsHubTab) => void;
  closeCatalogDetail: () => void;
  retryCatalogDetail: () => void;
  installCatalogEntry: (id: string) => void;
  setQuery: (query: string) => void;
  refreshCatalog: () => void;
  openPluginSettings: (pluginId: string | null, fromDiscovery: boolean) => void;
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

export type PluginsPageViewModel = {
  renderCredential?: PluginSettingsEditor["renderCredential"];
  help?: PluginHelpController;
  context: ApplicationContext;
  routeData?: PluginsRouteData;
  surface: "discovery" | "settings";
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  query: string;
  settingsTab: PluginSettingsTab;
  busy: Record<string, PluginMutationAction>;
  messages: Record<string, PluginRowMessage>;
  detail: PluginsPageDetail | null;
  iconUrls: Record<string, string>;
  catalogIconUrls: Record<string, string>;
  iconLoading?: (pluginId: string) => boolean;
  catalogIconLoading?: (url: string) => boolean;
  pageNotice: PluginRowMessage | null;
  catalogDetail: PluginsPageCatalogDetail | null;
  installedDetailTab: InstalledPluginDetailTab;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  canEditConfig: boolean;
  discovery: PluginDiscoveryController;
  consentController: PluginsConsentController;
  actions: PluginsPageViewActions;
  skillPreview: PluginPreviewController;
};

export function renderPluginsPage(model: PluginsPageViewModel) {
  model.help?.update(model);
  const ask = model.help?.available ? model.help.ask : undefined;
  const onAskPlugin = ask ? () => void ask() : undefined;
  const { actions, catalogDetail, consentController, context, detail, discovery } = model;
  const configState = context.runtimeConfig.state;
  const configAnalysis = analyzeConfigSchema(configState.configSchema);
  const catalog = catalogDetail?.result;
  const catalogVersion = catalog?.plugin.catalog.latestVersion;
  const catalogSkillsSection =
    catalog && catalogVersion && catalog.detail.skills.length
      ? renderPluginSkillsSection(catalog.detail.skills, (skillName) =>
          actions.openSkill({
            source: "catalog",
            catalogId: catalog.plugin.id,
            version: catalogVersion,
            skillName,
          }),
        )
      : undefined;
  const detailPluginId = detail?.pluginId ?? null;
  const activeCatalogInstall = catalogDetail
    ? consentController.getActiveInstall(`install:${catalogDetail.id}`)
    : undefined;
  const settingsParentRoute =
    new URLSearchParams(model.routeData?.location.search ?? "").get("from") === "plugins"
      ? "plugins"
      : "plugin-settings";
  const settingsShared = {
    connected: model.connected,
    loading: model.loading,
    result: model.result,
    error: model.error,
    busy: model.busy,
    messages: model.messages,
    iconUrls: model.iconUrls,
    iconLoading: model.iconLoading,
    canMutate: model.canMutate,
    mutationBlockedReason: model.mutationBlockedReason,
    configBusy: configState.configLoading,
    configError: configState.lastError,
    canEditConfig: model.canEditConfig,
    configValue: configState.configForm,
    configHints: configState.configUiHints,
    configSchemaLoading: configState.configSchemaLoading,
    configUnsupportedPaths: configAnalysis.unsupportedPaths,
    onIconError: actions.handlePluginIconError,
    onSetEnabled: actions.updateEnabled,
    onUninstall: actions.uninstall,
    onConfigPatch: actions.patchConfig,
    onConfigRemove: actions.removeConfig,
    onConfigReload: actions.reloadConfig,
    onConfigReadRetry: actions.retryConfigRead,
    onConfigWriteRetry: actions.retryConfigWrite,
    onRefresh: actions.refreshCatalog,
    onAskPlugin,
    onAskSetting: ask,
  };

  const renderInstalled = (pluginId: string) => {
    const components = detail?.inspection?.components;
    const skills = components?.skillDetails ?? components?.skills.map((name) => ({ name })) ?? [];
    const current = model.routeData?.location;
    const search = new URLSearchParams(current?.search);
    search.set("view", "settings");
    const settings = model.installedDetailTab === "configuration";
    const backSearch = new URLSearchParams(current?.search);
    backSearch.delete("view");
    const overviewHref = `${current?.pathname ?? ""}${backSearch.size ? `?${backSearch}` : ""}`;
    return renderPluginSettingsDetail({
      ...settingsShared,
      pluginId,
      installProgress: consentController.getActiveInstall(pluginRowKey(pluginId)),
      inspection: detail?.inspection ?? null,
      catalog: detail?.catalog,
      inspectionError: detail?.error ?? null,
      catalogLoading: detail?.catalogLoading,
      catalogIconUrls: model.catalogIconUrls,
      catalogIconLoading: model.catalogIconLoading,
      renderCredential: model.renderCredential,
      tools: detail?.tools,
      onOpenTool: actions.openTool,
      skillsSection: skills.length
        ? renderPluginSkillsSection(skills, (skillName) =>
            actions.openSkill({ source: "installed", pluginId, skillName }),
          )
        : !components
          ? catalogSkillsSection
          : undefined,
      settingsHref: `${current?.pathname ?? ""}?${search}`,
      configSchema: pluginConfigSchema(configAnalysis.schema, pluginId),
      hostControlsSchema: pluginHostControlsSchema(configAnalysis.schema, pluginId),
      backHref: settings
        ? overviewHref
        : pathForRoute(
            model.surface === "discovery" ? "plugins" : settingsParentRoute,
            context.basePath,
          ),
      backLabel:
        model.surface === "discovery" || settingsParentRoute === "plugins"
          ? t("tabs.plugins")
          : t("nav.settings"),
      tab: model.installedDetailTab,
      onBack: settings
        ? () => actions.selectInstalledDetailTab("readme")
        : model.surface === "discovery"
          ? actions.closeCatalogDetail
          : () => actions.closeSettingsDetail(settingsParentRoute),
      onRetryInspection: () => actions.retrySettingsDetail(pluginId),
      onTabChange: actions.selectInstalledDetailTab,
    });
  };

  return html`
    ${
      model.surface === "discovery" && !catalogDetail
        ? renderPluginsHubHeader({
            active: "plugins",
            onSelect: actions.selectHubTab,
            secondaryAction: {
              label: t("pluginsPage.pluginSettings"),
              icon: icons.settings,
              onClick: () => actions.openPluginSettings(null, false),
            },
          })
        : nothing
    }
    ${renderSettingsWorkspace(html`
      ${renderPluginRowMessage(model.pageNotice ?? undefined)}
      ${
        model.surface === "discovery"
          ? html`<wa-tab-panel
              id=${PLUGINS_HUB_PANEL_ID}
              name="plugins"
              active
              aria-labelledby="plugins-tab-plugins"
              >${
                catalogDetail
                  ? detailPluginId && !activeCatalogInstall
                    ? renderInstalled(detailPluginId)
                    : renderPluginCatalogDetail({
                        onAskPlugin,
                        connected: model.connected,
                        skillsSection: catalogSkillsSection,
                        result: catalogDetail.result,
                        error: catalogDetail.error,
                        backHref: pathForRoute("plugins", context.basePath),
                        onBack: actions.closeCatalogDetail,
                        onRetry: actions.retryCatalogDetail,
                        canInstall:
                          model.canMutate &&
                          !model.messages[`install:${catalogDetail.id}`]?.savedInstall &&
                          Boolean(
                            catalogDetail.result &&
                            installRequestForDiscoveryDetail(catalogDetail.result),
                          ),
                        installBlockedReason: model.mutationBlockedReason,
                        onInstall: () => actions.installCatalogEntry(catalogDetail.id),
                        busy: Boolean(model.busy[`install:${catalogDetail.id}`]),
                        installProgress: consentController.installProgress.get(
                          `install:${catalogDetail.id}`,
                        ),
                        message: model.messages[`install:${catalogDetail.id}`],
                        onContinueInstall: (request) =>
                          void consentController.install(request, `install:${catalogDetail.id}`),
                        iconUrls: model.catalogIconUrls,
                        iconLoading: model.catalogIconLoading,
                      })
                  : renderSettingsPage(
                      renderPluginCatalogResults({
                        connected: model.connected,
                        loading: discovery.loading,
                        result: discovery.result,
                        error: discovery.error ?? model.error,
                        remoteError: discovery.remoteError,
                        categories: discovery.categories,
                        categoriesLoading: discovery.categoriesLoading,
                        categoriesError: discovery.categoriesError,
                        onRetryCategories: () => void discovery.ensureCategories(true),
                        featured: discovery.featured,
                        featuredLoading: discovery.featuredLoading,
                        trending: discovery.trending,
                        trendingLoading: discovery.trendingLoading,
                        loadingMore: discovery.loadingMore,
                        loadMoreError: discovery.loadMoreError,
                        intent: discovery.intent,
                        category: discovery.category,
                        query: discovery.query,
                        iconUrls: model.catalogIconUrls,
                        pluginIconUrls: model.iconUrls,
                        iconLoading: model.catalogIconLoading,
                        pluginIconLoading: model.iconLoading,
                        canInstall: model.canMutate,
                        installProgress: consentController.installProgress,
                        entryHref: (id) => pathForPluginCatalogEntry(id, context.basePath),
                        onIntentChange: (intent) => discovery.selectIntent(intent),
                        onCategoryChange: (category) => discovery.selectCategory(category),
                        onQueryChange: (query) => discovery.updateQuery(query),
                        onOpenEntry: (id) =>
                          context.navigate("plugins", {
                            pathname: pathForPluginCatalogEntry(id, context.basePath),
                          }),
                        onInstall: actions.installCatalogEntry,
                        busy: model.busy,
                        messages: model.messages,
                        onContinueInstall: (id, request) =>
                          void consentController.install(request, `install:${id}`),
                        onLoadMore: () => void discovery.loadMore(),
                        onRetry: () => void discovery.refresh(),
                      }),
                      { wide: true, carapace: true },
                    )
              }</wa-tab-panel
            >`
          : detailPluginId
            ? renderInstalled(detailPluginId)
            : renderPluginSettingsInventory({
                ...settingsShared,
                tab: model.settingsTab,
                query: model.query,
                advancedSchema: pluginAdvancedSchema(configAnalysis.schema),
                onTabChange: actions.selectSettingsTab,
                onQueryChange: actions.setQuery,
                pluginHref: (pluginId) => pathForPluginSettings(pluginId, context.basePath),
                onOpenPlugin: (pluginId) => actions.openPluginSettings(pluginId, false),
              })
      }
    `)}
    ${renderPluginSkillPreview(model.skillPreview)}
    ${
      consentController.consent
        ? renderPluginConsentDialog({
            consent: consentController.consent,
            inspection: consentController.inspection,
            loading: consentController.inspectionLoading,
            error: consentController.inspectionError,
            iconUrl: consentController.consent.pluginId
              ? model.iconUrls[consentController.consent.pluginId]
              : undefined,
            iconLoading: Boolean(
              consentController.consent.pluginId &&
              model.iconLoading?.(consentController.consent.pluginId),
            ),
            canMutate: model.canMutate,
            mutationBlockedReason: model.mutationBlockedReason,
            busy: Object.values(model.busy).some(Boolean),
            onCancel: () => consentController.close(),
            onConfirm: () => consentController.confirm(),
            onRetry: () => void consentController.inspect(),
          })
        : nothing
    }
  `;
}
