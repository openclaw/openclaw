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
import type {
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail } from "./catalog-detail.ts";
import { renderPluginCatalogResults } from "./catalog-results.ts";
import { renderPluginConsentDialog } from "./consent-dialog.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import type { InstallWizardController } from "./install-wizard-controller.ts";
import {
  installRequestForDiscoveryDetail,
  type PluginInstallWizardState,
} from "./install-wizard-model.ts";
import { renderPluginInstallWizard } from "./install-wizard.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import type { PluginHelpController } from "./plugin-help-controller.ts";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";
import { renderPluginsHubHeader } from "./plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
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

type CatalogDetailState = {
  id: string;
  result: PluginDiscoveryDetailResult | null;
  error: string | null;
};

type InstalledDetailState = {
  tools?: Array<{ name: string; description?: string }>;
  pluginId: string;
  inspection: PluginsInspectResult | null;
  error: string | null;
};

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
  reload: (pluginId: string, rowKey: string) => void;
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
  busy: Record<string, boolean>;
  messages: Record<string, PluginRowMessage>;
  detail: InstalledDetailState | null;
  iconUrls: Record<string, string>;
  catalogIconUrls: Record<string, string>;
  pageNotice: PluginRowMessage | null;
  catalogDetail: CatalogDetailState | null;
  installedDetailTab: InstalledPluginDetailTab;
  installWizard: PluginInstallWizardState | null;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  reloadBlockedReason: string | null;
  canEditConfig: boolean;
  discovery: PluginDiscoveryController;
  consentController: PluginsConsentController;
  installWizardController: InstallWizardController;
  actions: PluginsPageViewActions;
  skillPreview: PluginPreviewController;
};

export function renderPluginsPage(model: PluginsPageViewModel) {
  model.help?.update(model);
  const ask = model.help?.available ? model.help.ask : undefined;
  const onAskPlugin = ask ? () => void ask() : undefined;
  const {
    actions,
    catalogDetail,
    consentController,
    context,
    detail,
    discovery,
    installWizard,
    installWizardController,
  } = model;
  const configState = context.runtimeConfig.state;
  const configAnalysis = analyzeConfigSchema(configState.configSchema);
  const installWizardConfigSchema = installWizard?.pluginId
    ? pluginConfigSchema(configAnalysis.schema, installWizard.pluginId)
    : null;
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
    canMutate: model.canMutate,
    reloadBlockedReason: model.reloadBlockedReason,
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
    onReload: actions.reload,
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
      inspection: detail?.inspection ?? null,
      inspectionError: detail?.error ?? null,
      renderCredential: model.renderCredential,
      tools: detail?.tools,
      onOpenTool: actions.openTool,
      skillsSection: skills.length
        ? renderPluginSkillsSection(skills, (skillName) =>
            actions.openSkill({ source: "installed", pluginId, skillName }),
          )
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
      <openclaw-plugin-manager></openclaw-plugin-manager>
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
                  ? detailPluginId
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
                          Boolean(
                            catalogDetail.result &&
                            installRequestForDiscoveryDetail(catalogDetail.result),
                          ),
                        installBlockedReason: model.mutationBlockedReason,
                        onInstall: () => {
                          if (catalogDetail.result) {
                            installWizardController.open(catalogDetail.result);
                          }
                        },
                        iconUrls: model.catalogIconUrls,
                      })
                  : renderSettingsPage(
                      renderPluginCatalogResults({
                        connected: model.connected,
                        loading: discovery.loading,
                        result: discovery.result,
                        error: discovery.error ?? model.error,
                        remoteError: discovery.remoteError,
                        categories: discovery.categories,
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
                        canInstall: model.canMutate,
                        entryHref: (id) => pathForPluginCatalogEntry(id, context.basePath),
                        onIntentChange: (intent) => discovery.selectIntent(intent),
                        onCategoryChange: (category) => discovery.selectCategory(category),
                        onQueryChange: (query) => discovery.updateQuery(query),
                        onOpenEntry: (id) =>
                          context.navigate("plugins", {
                            pathname: pathForPluginCatalogEntry(id, context.basePath),
                          }),
                        onInstall: actions.installCatalogEntry,
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
    ${
      installWizard
        ? renderPluginInstallWizard({
            state: installWizard,
            mutationBlockedReason: model.mutationBlockedReason,
            canMutate: model.canMutate,
            busy: Object.values(model.busy).some(Boolean),
            configSchema: installWizardConfigSchema,
            configSchemaLoading: configState.configSchemaLoading,
            configValue: installWizard.configDraft?.value ?? null,
            configHints: configState.configUiHints,
            configUnsupportedPaths: configAnalysis.unsupportedPaths,
            configBusy: configState.configLoading || configState.configSaving,
            configError: configState.lastError,
            canEditConfig: model.canEditConfig,
            onClose: () => installWizardController.close(),
            onInstall: () => installWizardController.begin(),
            onContinuePolicyWarning: () => installWizardController.continuePolicyWarning(),
            onRetry: () => installWizardController.retry(),
            onConfigPatch: (path, value) => installWizardController.patchConfiguration(path, value),
            onConfigRemove: (path) => installWizardController.removeConfiguration(path),
            onSaveConfiguration: () => void installWizardController.saveConfiguration(),
            onManage: () => installWizardController.manage(),
          })
        : nothing
    }
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
            canMutate: model.canMutate,
            mutationBlockedReason: model.mutationBlockedReason,
            busy: Object.values(model.busy).some(Boolean),
            onCancel: () => installWizardController.cancelConsent(),
            onConfirm: () => consentController.confirm(),
            onRetry: () => void consentController.inspect(),
          })
        : nothing
    }
  `;
}
