import type { JSX } from "@solidjs/web";
import type { TemplateResult } from "lit";
import { createMemo } from "solid-js";
import type { PluginsSkillsReadParams } from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { analyzeConfigSchema } from "../../components/config-form.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { t } from "../../i18n/index.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { LitContent } from "../../lit/lit-content.tsx";
import { renderPluginCatalogDetail as PluginCatalogDetail } from "./catalog-detail.tsx";
import { renderPluginCatalogResults as PluginCatalogResults } from "./catalog-results.tsx";
import { renderPluginConsentDialog as PluginConsentDialog } from "./consent-dialog.tsx";
import { pluginDetailLocation, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import type { PluginHelpController } from "./plugin-help-controller.ts";
import {
  pluginRowKey,
  renderPluginRowMessage as PluginRowMessageView,
  type PluginRowMessage,
} from "./plugin-row-message.tsx";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";
import { PluginsHubHeader } from "./plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
import {
  installRequestForDiscoveryDetail,
  type PluginMutationAction,
  type PluginsPageCatalogDetail,
  type PluginsPageDetail,
} from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsEditorProps } from "./settings-editor.tsx";
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
import {
  PluginSkillPreview,
  renderPluginSkillsSection,
  type PluginPreviewController,
} from "./skill-preview.tsx";

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

export type PluginsPageViewModel = {
  mcpLogin: TemplateResult;
  mcpLoginBusy: boolean;
  canMcpLogin: boolean;
  resolveCredential?: PluginSettingsEditorProps["resolveCredential"];
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

export function PluginsPageView(props: { model: PluginsPageViewModel }) {
  const ask = createMemo(() => {
    props.model.help?.update(props.model);
    return props.model.help?.available ? props.model.help.ask : undefined;
  });
  const onAskPlugin = createMemo(() => {
    const staticAsk = ask();
    return staticAsk ? () => void staticAsk() : undefined;
  });
  const configState = () => props.model.context.runtimeConfig.state;
  const configAnalysis = createMemo(() => analyzeConfigSchema(configState().configSchema));
  const detailPluginId = () => props.model.detail?.pluginId;
  const catalogId = () => props.model.catalogDetail?.id ?? "";
  const settingsParentRoute = () =>
    new URLSearchParams(props.model.routeData?.location.search ?? "").get("from") === "plugins"
      ? ("plugins" as const)
      : ("plugin-settings" as const);
  const catalogSkillsSection = () => {
    const catalog = props.model.catalogDetail?.result;
    const version = catalog?.plugin.catalog.latestVersion;
    const openSkill = props.model.actions.openSkill;
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
    connected: props.model.connected,
    loading: props.model.loading,
    result: props.model.result,
    error: props.model.error,
    busy: props.model.busy,
    messages: props.model.messages,
    iconUrls: props.model.iconUrls,
    iconLoading: props.model.iconLoading,
    canMutate: props.model.canMutate,
    mutationBlockedReason: props.model.mutationBlockedReason,
    configBusy: configState().configLoading,
    configError: configState().lastError,
    canEditConfig: props.model.canEditConfig,
    configValue: configState().configForm,
    configHints: configState().configUiHints,
    configSchemaLoading: configState().configSchemaLoading,
    configUnsupportedPaths: configAnalysis().unsupportedPaths,
    onIconError: props.model.actions.handlePluginIconError,
    onSetEnabled: props.model.actions.updateEnabled,
    onUninstall: props.model.actions.uninstall,
    onConfigPatch: props.model.actions.patchConfig,
    onConfigRemove: props.model.actions.removeConfig,
    onConfigReload: props.model.actions.reloadConfig,
    onConfigReadRetry: props.model.actions.retryConfigRead,
    onConfigWriteRetry: props.model.actions.retryConfigWrite,
    onRefresh: props.model.actions.refreshCatalog,
    onAskPlugin: onAskPlugin(),
    onAskSetting: ask(),
  }));

  function InstalledDetail(detailProps: { pluginId: string }) {
    const components = () => props.model.detail?.inspection?.components;
    const skills = createMemo(
      () => components()?.skillDetails ?? components()?.skills.map((name) => ({ name })) ?? [],
    );
    const settings = () => props.model.installedDetailTab === "configuration";
    const settingsLocation = () => pluginDetailLocation(props.model.routeData?.location, true);
    const overviewLocation = () => pluginDetailLocation(props.model.routeData?.location, false);
    return (
      <PluginSettingsDetail
        {...shared()}
        pluginId={detailProps.pluginId}
        installProgress={props.model.consentController.getActiveInstall(
          pluginRowKey(detailProps.pluginId),
        )}
        inspection={props.model.detail?.inspection ?? null}
        mcpLoginBusy={props.model.mcpLoginBusy}
        canMcpLogin={props.model.canMcpLogin}
        onMcpLogin={props.model.actions.startMcpLogin}
        onEditMcp={() => props.model.context.navigate("mcp")}
        catalog={props.model.detail?.catalog}
        inspectionError={props.model.detail?.error ?? null}
        catalogLoading={props.model.detail?.catalogLoading}
        catalogIconUrls={props.model.catalogIconUrls}
        catalogIconLoading={props.model.catalogIconLoading}
        resolveCredential={props.model.resolveCredential}
        tools={props.model.detail?.tools}
        onOpenTool={props.model.actions.openTool}
        skillsSection={
          skills().length
            ? renderPluginSkillsSection(skills(), (skillName) =>
                props.model.actions.openSkill({
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
                props.model.surface === "discovery" ? "plugins" : settingsParentRoute(),
                props.model.context.basePath,
              )
        }
        backLabel={
          props.model.surface === "discovery" || settingsParentRoute() === "plugins"
            ? t("tabs.plugins")
            : t("nav.settings")
        }
        tab={props.model.installedDetailTab}
        onBack={() => {
          if (settings()) {
            props.model.actions.selectInstalledDetailTab("readme");
          } else if (props.model.surface === "discovery") {
            props.model.actions.closeCatalogDetail();
          } else {
            props.model.actions.closeSettingsDetail(settingsParentRoute());
          }
        }}
        onRetryInspection={() => props.model.actions.retrySettingsDetail(detailProps.pluginId)}
        onTabChange={props.model.actions.selectInstalledDetailTab}
      />
    );
  }

  return (
    <>
      {props.model.surface === "discovery" && !props.model.catalogDetail && (
        <PluginsHubHeader
          active="plugins"
          onSelect={props.model.actions.selectHubTab}
          secondaryAction={{
            label: t("pluginsPage.pluginSettings"),
            icon: <Icon name="settings" />,
            onClick: () => props.model.actions.openPluginSettings(null),
          }}
        />
      )}
      <SettingsWorkspace>
        {PluginRowMessageView(props.model.pageNotice ?? undefined)}
        {props.model.surface === "discovery" ? (
          <wa-tab-panel
            id={PLUGINS_HUB_PANEL_ID}
            name="plugins"
            active
            aria-labelledby="plugins-tab-plugins"
          >
            {props.model.catalogDetail ? (
              detailPluginId() &&
              !props.model.consentController.getActiveInstall(`install:${catalogId()}`) ? (
                <InstalledDetail pluginId={detailPluginId()!} />
              ) : (
                <PluginCatalogDetail
                  onAskPlugin={onAskPlugin()}
                  connected={props.model.connected}
                  skillsSection={catalogSkillsSection()}
                  result={props.model.catalogDetail?.result ?? null}
                  error={props.model.catalogDetail?.error ?? null}
                  backHref={pathForRoute("plugins", props.model.context.basePath)}
                  onBack={props.model.actions.closeCatalogDetail}
                  onRetry={props.model.actions.retryCatalogDetail}
                  canInstall={
                    props.model.canMutate &&
                    !props.model.messages[`install:${catalogId()}`]?.savedInstall &&
                    Boolean(
                      props.model.catalogDetail?.result &&
                      installRequestForDiscoveryDetail(props.model.catalogDetail.result),
                    )
                  }
                  installBlockedReason={props.model.mutationBlockedReason}
                  onInstall={() => props.model.actions.installCatalogEntry(catalogId())}
                  busy={Boolean(props.model.busy[`install:${catalogId()}`])}
                  installProgress={props.model.consentController.installProgress.get(
                    `install:${catalogId()}`,
                  )}
                  message={props.model.messages[`install:${catalogId()}`]}
                  onContinueInstall={(request) =>
                    void props.model.consentController.install(request, `install:${catalogId()}`)
                  }
                  iconUrls={props.model.catalogIconUrls}
                  iconLoading={props.model.catalogIconLoading}
                />
              )
            ) : (
              <SettingsPage wide carapace>
                <PluginCatalogResults
                  connected={props.model.connected}
                  loading={props.model.discovery.loading}
                  result={props.model.discovery.result}
                  error={props.model.discovery.error ?? props.model.error}
                  remoteError={props.model.discovery.remoteError}
                  categories={props.model.discovery.categories}
                  categoriesLoading={props.model.discovery.categoriesLoading}
                  categoriesError={props.model.discovery.categoriesError}
                  onRetryCategories={() => void props.model.discovery.ensureCategories(true)}
                  featured={props.model.discovery.featured}
                  trending={props.model.discovery.trending}
                  loadingMore={props.model.discovery.loadingMore}
                  loadMoreError={props.model.discovery.loadMoreError}
                  intent={props.model.discovery.intent}
                  category={props.model.discovery.category}
                  query={props.model.discovery.query}
                  iconUrls={props.model.catalogIconUrls}
                  pluginIconUrls={props.model.iconUrls}
                  iconLoading={props.model.catalogIconLoading}
                  pluginIconLoading={props.model.iconLoading}
                  canInstall={props.model.canMutate}
                  installProgress={props.model.consentController.installProgress}
                  entryHref={(id) => pathForPluginCatalogEntry(id, props.model.context.basePath)}
                  onIntentChange={(intent) => props.model.discovery.selectIntent(intent)}
                  onCategoryChange={(category) => props.model.discovery.selectCategory(category)}
                  onQueryChange={(query) => props.model.discovery.updateQuery(query)}
                  onOpenEntry={(id) =>
                    props.model.context.navigate("plugins", {
                      pathname: pathForPluginCatalogEntry(id, props.model.context.basePath),
                    })
                  }
                  onInstall={props.model.actions.installCatalogEntry}
                  busy={props.model.busy}
                  messages={props.model.messages}
                  onContinueInstall={(id, request) =>
                    void props.model.consentController.install(request, `install:${id}`)
                  }
                  onLoadMore={() => void props.model.discovery.loadMore()}
                  onRetry={() => void props.model.discovery.refresh()}
                />
              </SettingsPage>
            )}
          </wa-tab-panel>
        ) : detailPluginId() ? (
          <InstalledDetail pluginId={detailPluginId()!} />
        ) : (
          <PluginSettingsInventory
            {...shared()}
            tab={props.model.settingsTab}
            query={props.model.query}
            advancedSchema={pluginAdvancedSchema(configAnalysis().schema)}
            onTabChange={props.model.actions.selectSettingsTab}
            onQueryChange={props.model.actions.setQuery}
            pluginHref={(pluginId) => pathForPluginSettings(pluginId, props.model.context.basePath)}
            onOpenPlugin={(pluginId) => props.model.actions.openPluginSettings(pluginId)}
          />
        )}
      </SettingsWorkspace>
      <PluginSkillPreview
        controller={props.model.skillPreview}
        state={props.model.skillPreview.state}
      />
      <LitContent>{props.model.mcpLogin}</LitContent>
      {props.model.consentController.consent && (
        <PluginConsentDialog
          consent={props.model.consentController.consent!}
          inspection={props.model.consentController.inspection}
          loading={props.model.consentController.inspectionLoading}
          error={props.model.consentController.inspectionError}
          iconUrl={
            props.model.consentController.consent?.pluginId
              ? props.model.iconUrls[props.model.consentController.consent.pluginId]
              : undefined
          }
          iconLoading={Boolean(
            props.model.consentController.consent?.pluginId &&
            props.model.iconLoading?.(props.model.consentController.consent.pluginId),
          )}
          canMutate={props.model.canMutate}
          mutationBlockedReason={props.model.mutationBlockedReason}
          busy={Object.values(props.model.busy).some(Boolean)}
          onCancel={() => props.model.consentController.close()}
          onConfirm={() => props.model.consentController.confirm()}
          onRetry={() => void props.model.consentController.inspect()}
        />
      )}
    </>
  );
}

export function renderPluginsPage(model: PluginsPageViewModel): JSX.Element {
  return <PluginsPageView model={model} />;
}
