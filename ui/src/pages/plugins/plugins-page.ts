import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  pathForPluginSettings,
  pathForRoute,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import {
  loadPluginDiscoveryDetail,
  uninstallPlugin,
  type PluginListResult,
  type PluginMutationResult,
} from "../../lib/plugins/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/plugins.css";
import type { PluginCatalogDetailTab } from "./catalog-detail.ts";
import { installedPluginDetailTabFromHash, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import { InstallWizardController } from "./install-wizard-controller.ts";
import type { PluginInstallWizardState } from "./install-wizard-model.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import { confirmPluginUninstall } from "./plugin-lifecycle-confirmation.ts";
import type { PluginRowMessage } from "./plugin-row-message.ts";
import { PluginsConsentController } from "./plugins-consent-controller.ts";
import type { PluginsHubTab } from "./plugins-hub.ts";
import { PluginsPageIcons } from "./plugins-page-icons.ts";
import {
  mergePluginCatalogItem,
  pluginMutationBlockedReason,
  type PluginsPageCatalogDetail,
  type PluginsPageDetail,
} from "./plugins-page-model.ts";
import { renderPluginsPage } from "./plugins-page-view.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsTab } from "./settings-view.ts";

type PluginsPageSurface = "discovery" | "settings";

class PluginsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: PluginsRouteData;
  @property({ attribute: false }) surface: PluginsPageSurface = "settings";

  @state() private result: PluginListResult | null = null;
  @state() private error: string | null = null;
  @state() private query = "";
  @state() private settingsTab: PluginSettingsTab = "installed";
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, PluginRowMessage> = {};
  @state() private detail: PluginsPageDetail | null = null;
  @state() private iconUrls: Record<string, string> = {};
  @state() private catalogIconUrls: Record<string, string> = {};
  @state() private pageNotice: PluginRowMessage | null = null;
  @state() private catalogDetail: PluginsPageCatalogDetail | null = null;
  @state() private catalogDetailTab: PluginCatalogDetailTab = "readme";
  @state() private installedDetailTab: InstalledPluginDetailTab = "readme";
  @state() private installWizard: PluginInstallWizardState | null = null;
  private configAutoSaveStatus = this.context?.runtimeConfig.state.configAutoSaveStatus ?? "idle";
  private pluginConfigEditPending = false;
  private routeDataConsumed = false;
  private preserveMessageKeyOnReconnect: string | null = null;
  private iconAuthCandidates: string[] = [];
  private readonly icons = new PluginsPageIcons({
    getContext: () => this.context,
    isConnected: () => this.isConnected,
    onInstalledUrlsChange: (urls) => {
      this.iconUrls = urls;
    },
    onCatalogUrlsChange: (urls) => {
      this.catalogIconUrls = urls;
    },
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      const preservedKey = this.preserveMessageKeyOnReconnect;
      const preservedMessage = preservedKey ? this.messages[preservedKey] : undefined;
      this.preserveMessageKeyOnReconnect = null;
      this.result = null;
      this.error = null;
      this.messages = preservedKey && preservedMessage ? { [preservedKey]: preservedMessage } : {};
      this.pageNotice = null;
    },
    invalidateRequests: (change) =>
      this.invalidateRequests(
        change.identityChanged || change.snapshot.phase !== "connected" || !change.snapshot.client,
      ),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });
  private readonly discovery = new PluginDiscoveryController(this, {
    getClient: () => this.gateway.client,
    isConnected: () => this.gateway.connected,
    capture: () => this.gateway.capture(),
    isCurrent: (scope) => this.gateway.isCurrent(scope),
    onEntriesChanged: () => this.syncCatalogIcons(),
  });

  private readonly consentController = new PluginsConsentController({
    gateway: this.gateway,
    getContext: () => this.context,
    getResult: () => this.result,
    canMutate: () => this.canMutate(),
    isBusy: (rowKey) => Boolean(this.busy[rowKey]),
    setBusy: (rowKey, busy) => this.setBusy(rowKey, busy),
    setMessage: (rowKey, message) => this.setMessage(rowKey, message),
    clearPageNotice: () => {
      this.pageNotice = null;
    },
    closeDetails: () => {
      if (this.surface !== "settings") {
        this.detail = null;
      }
    },
    applyMutationResult: (result) => this.applyMutationResult(result),
    refreshCatalogAfterMutation: (client) => this.refreshCatalogAfterMutation(client),
    reconnectAfterMutation: (rowKey) => {
      // The reconnect refreshes hello-owned plugin tabs. Keep only its committed
      // outcome; unrelated Gateway identity changes still clear all row messages.
      this.preserveMessageKeyOnReconnect = rowKey;
      this.context.gateway.connect();
    },
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly installWizardController = new InstallWizardController({
    getState: () => this.installWizard,
    setState: (wizard) => {
      this.installWizard = wizard;
    },
    getCatalog: () => this.result,
    getRuntimeConfig: () => this.context.runtimeConfig,
    getConsentController: () => this.consentController,
    getOwner: () => gatewayPresentationScope(this.context.gateway),
    getBootId: () => this.gateway.snapshot?.hello?.server?.bootId,
    isConnected: () => this.gateway.connected,
    canMutate: () => this.canMutate(),
    canEditConfig: () => this.canEditConfig(),
    refreshCatalog: () => this.refreshCatalog(),
    requestRestart: async (reason) => {
      const scope = this.gateway.capture();
      if (!scope) {
        throw new Error(t("pluginsPage.installWizard.restartFailed"));
      }
      await scope.client.request("gateway.restart.request", { reason });
    },
    onManage: (pluginId) => {
      this.context.navigate("plugin-settings", {
        pathname: pathForPluginSettings(pluginId, this.context.basePath),
        search: "?from=plugins",
      });
    },
  });

  private readonly catalogTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client ? client.request<PluginListResult>("plugins.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.replaceResult(result);
      const routePluginId = this.surface === "settings" ? this.activeRoutePluginId : null;
      if (routePluginId && routePluginId !== this.detail?.pluginId) {
        void this.showDetails(routePluginId);
      }
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      if (this.surface === "settings" || this.installWizard?.stage === "configuring") {
        void runtimeConfig.ensureLoaded();
        void runtimeConfig.ensureSchemaLoaded();
      }
      this.configAutoSaveStatus = runtimeConfig.state.configAutoSaveStatus;
      return runtimeConfig.subscribe(() => {
        const nextStatus = runtimeConfig.state.configAutoSaveStatus;
        const completedSave = this.configAutoSaveStatus === "saving" && nextStatus === "saved";
        this.configAutoSaveStatus = nextStatus;
        this.requestUpdate();
        if (completedSave && this.pluginConfigEditPending) {
          this.pluginConfigEditPending = false;
          const detailPluginId = this.detail?.pluginId;
          void this.refreshCatalog().then(() => {
            if (detailPluginId && this.detail?.pluginId === detailPluginId) {
              void this.showDetails(detailPluginId);
            }
          });
        }
      });
    },
  );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override updated() {
    const renderedPluginIds = new Set<string>();
    // Rendered tile markers preserve the inventory's sorting, filtering, and collapse policy.
    for (const tile of this.querySelectorAll<HTMLElement>("[data-plugin-icon-id]")) {
      const pluginId = tile.dataset.pluginIconId;
      if (pluginId) {
        renderedPluginIds.add(pluginId);
      }
    }
    this.icons.syncInstalled(this.result, renderedPluginIds);
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.installWizardController.disconnect();
    this.discovery.disconnect();
    this.subscriptions.clear();
    this.icons.reset();
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (document.querySelector(".shell-nav[aria-modal='true']")) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }
    if (this.consentController.consent) {
      this.installWizardController.cancelConsent();
      event.stopPropagation();
      return;
    }
    if (this.installWizard && !this.installWizardController.busy) {
      this.installWizardController.close();
      event.stopPropagation();
      return;
    }
    if (this.detail) {
      this.detail = null;
      if (this.surface === "settings") {
        this.context.replace("plugin-settings", {
          pathname: pathForRoute("plugin-settings", this.context.basePath),
        });
      }
      event.stopPropagation();
      return;
    }
    if (this.catalogDetail) {
      this.closeCatalogDetail();
      event.stopPropagation();
    }
  };

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    const nextIconAuthCandidates = resolveControlUiAuthCandidates({
      hello: snapshot.hello,
      settings: { token: this.context.gateway.connection.token },
      password: this.context.gateway.connection.password,
    });
    const iconAuthChanged =
      nextIconAuthCandidates.length !== this.iconAuthCandidates.length ||
      nextIconAuthCandidates.some(
        (candidate, index) => candidate !== this.iconAuthCandidates[index],
      );
    this.iconAuthCandidates = nextIconAuthCandidates;
    const shouldRefreshAfterChange =
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged) &&
      snapshot.phase === "connected" &&
      this.routeDataConsumed;
    if (
      !change.initial &&
      iconAuthChanged &&
      !change.identityChanged &&
      !change.connectionChanged
    ) {
      this.gateway.invalidate();
      this.invalidateRequests(snapshot.phase !== "connected" || !snapshot.client);
    }
    if (
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged)
    ) {
      this.icons.reset();
      this.busy = {};
    }
    if (shouldRefreshAfterChange) {
      void this.refreshCatalog().then(() => this.installWizardController.resume());
      if (this.surface === "discovery") {
        const catalogId = this.activeRoutePluginId;
        if (catalogId) {
          void this.showCatalogDetail(catalogId);
        } else {
          void this.discovery.refresh();
          void this.discovery.refreshCategories();
          void this.discovery.refreshFeatured();
          void this.discovery.refreshTrending();
        }
      }
    } else {
      this.ensureInitialData();
    }
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataConsumed = true;
    const detailPluginId = this.surface === "settings" ? this.activeRoutePluginId : null;
    const catalogId = this.surface === "discovery" ? this.activeRoutePluginId : null;
    // Route location is UI state, not Gateway data. Apply it even when the
    // catalog snapshot is stale so deep links do not fall back to Installed.
    if (this.surface === "settings" && !detailPluginId) {
      this.settingsTab =
        new URLSearchParams(data.location.search).get("tab") === "advanced"
          ? "advanced"
          : "installed";
    }
    if (detailPluginId) {
      this.installedDetailTab = installedPluginDetailTabFromHash(data.location.hash);
    }
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.ensureInitialData();
      return;
    }
    this.replaceResult(data.result);
    this.error = data.error;
    if (detailPluginId !== this.detail?.pluginId) {
      void this.showDetails(detailPluginId);
    }
    if (catalogId !== this.catalogDetail?.id) {
      void this.showCatalogDetail(catalogId);
    }
    this.ensureInitialData();
  }

  private invalidateRequests(invalidateCatalog = true) {
    if (invalidateCatalog) {
      void this.catalogTask.run([null]);
      this.discovery.invalidate();
    }
    // Inspection results belong to one connection epoch, including same-client reconnects.
    this.detail = null;
    this.catalogDetail = null;
    this.installWizardController.invalidate();
    this.consentController.reset();
  }

  private replaceResult(result: PluginListResult | null, preserveIcons = false) {
    if (preserveIcons) {
      this.icons.reconcileInstalled(result);
    } else {
      this.icons.resetInstalled();
    }
    this.result = result;
  }

  private get loading(): boolean {
    return (
      this.gateway.connected &&
      (!this.routeDataConsumed || this.catalogTask.status === TaskStatus.PENDING)
    );
  }

  private get activeRoutePluginId(): string | null {
    const pathname = this.routeData?.location.pathname ?? "";
    return this.surface === "settings"
      ? pluginSettingsIdFromPath(pathname, this.context.basePath)
      : pluginCatalogIdFromPath(pathname, this.context.basePath);
  }

  private ensureInitialData() {
    // The route owns initial loading; a warm page module can render before its data arrives.
    if (
      !this.routeDataConsumed ||
      !this.gateway.connected ||
      !this.gateway.client ||
      (this.routeData && !this.routeDataConsumed)
    ) {
      return;
    }
    if (!this.loading && !this.result && !this.error) {
      void this.refreshCatalog();
    }
    if (this.surface === "discovery") {
      const catalogId = this.activeRoutePluginId;
      if (catalogId) {
        if (catalogId !== this.catalogDetail?.id) {
          void this.showCatalogDetail(catalogId);
        }
      } else {
        this.discovery.ensureInitial();
      }
    }
  }

  private async refreshCatalog(): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "plugins") {
      if (this.surface !== "discovery") {
        this.context.navigate("plugins");
      }
      return;
    }
    this.context.navigate("skills");
  }

  private mutationBlockedReason(): string | null {
    return pluginMutationBlockedReason({
      connected: this.gateway.connected,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      mutationAllowed: this.result?.mutationAllowed,
    });
  }

  private canMutate(): boolean {
    return Boolean(this.result?.mutationAllowed) && this.mutationBlockedReason() === null;
  }

  private configBlockedReason(): string | null {
    return pluginMutationBlockedReason({
      connected: this.context.runtimeConfig.state.connected,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      mutationAllowed: this.context.runtimeConfig.canSet,
    });
  }

  private canEditConfig(): boolean {
    return this.configBlockedReason() === null;
  }

  private setBusy(key: string, value: boolean) {
    const next = { ...this.busy };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.busy = next;
  }

  private setMessage(key: string, message: PluginRowMessage | null) {
    const next = { ...this.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.messages = next;
  }

  private applyMutationResult(result: PluginMutationResult) {
    this.icons.invalidateInstalled(result.plugin.id);
    this.replaceResult(mergePluginCatalogItem(this.result, result.plugin), true);
  }

  /** Plugin changes can affect both catalog state and route visibility (for example Workboard). */
  private async refreshCatalogAfterMutation(client: GatewayBrowserClient): Promise<void> {
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private async showDetails(pluginId: string | null) {
    const detail = pluginId ? { pluginId, inspection: null, error: null } : null;
    this.detail = detail;
    const plugin = pluginId
      ? this.result?.plugins.find((entry) => entry.id === pluginId)
      : undefined;
    const scope = this.gateway.capture();
    if (!plugin?.installed || !detail || !scope) {
      return;
    }
    try {
      const inspection = await inspectPlugin(scope.client, plugin.id);
      if (this.gateway.isCurrent(scope) && this.detail === detail) {
        this.detail = { ...detail, inspection };
      }
      if (!plugin.catalogId) {
        return;
      }
      try {
        const catalog = await loadPluginDiscoveryDetail(
          scope.client,
          plugin.catalogId,
          undefined,
          plugin.version,
        );
        if (this.gateway.isCurrent(scope) && this.detail?.pluginId === plugin.id) {
          this.detail = { ...this.detail, inspection: { ...inspection, catalog } };
        }
      } catch {
        // ClawHub presentation is optional; local capabilities and controls are already visible.
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.detail === detail) {
        this.detail = { ...detail, error: formatUiError(error) };
      }
    }
  }

  private async showCatalogDetail(id: string | null) {
    const detail = id ? { id, result: null, error: null } : null;
    this.catalogDetail = detail;
    this.catalogDetailTab = "readme";
    const scope = this.gateway.capture();
    if (!detail || !scope) {
      return;
    }
    try {
      const result = await loadPluginDiscoveryDetail(scope.client, detail.id);
      if (this.gateway.isCurrent(scope) && this.catalogDetail === detail) {
        this.catalogDetail = { ...detail, result };
        this.syncCatalogIcons();
        if (new URLSearchParams(this.routeData?.location.search).get("action") === "install") {
          // A chat-card link opens review only; the existing wizard owns install consent.
          this.context.replace("plugins", {
            pathname: this.routeData?.location.pathname,
            search: "",
          });
          this.installWizardController.open(result);
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.catalogDetail === detail) {
        this.catalogDetail = { ...detail, error: formatUiError(error) };
      }
    }
  }

  private async installCatalogEntry(id: string): Promise<void> {
    const scope = this.gateway.capture();
    if (!scope || !this.canMutate()) {
      return;
    }
    try {
      const result = await loadPluginDiscoveryDetail(scope.client, id);
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.syncCatalogIcons(result);
      this.installWizardController.open(result);
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.discovery.error = formatUiError(error);
        this.requestUpdate();
      }
    }
  }

  private closeCatalogDetail() {
    this.catalogDetail = null;
    this.catalogDetailTab = "readme";
    this.context.navigate("plugins", {
      pathname: pathForRoute("plugins", this.context.basePath),
    });
  }

  private syncCatalogIcons(detail = this.catalogDetail?.result) {
    this.icons.syncCatalog(
      [
        ...(this.discovery.result?.items ?? []),
        ...this.discovery.featured,
        ...this.discovery.trending,
        ...(detail ? [detail.plugin] : []),
      ],
      detail?.detail.author?.imageUrl ? [detail.detail.author.imageUrl] : [],
    );
  }

  private async uninstall(pluginId: string, rowKey: string): Promise<void> {
    const name = this.result?.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
    await this.consentController.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, _isCurrent, isLatest) => {
        // Removal hides its row, so keep the restart reminder on the page.
        if (isLatest()) {
          this.pageNotice = {
            kind: "success",
            text: [
              t("pluginsPage.removedRestart", { name }),
              ...(result.warnings ?? []).map((warning) => formatUiExternalText(warning)),
              refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
            ]
              .filter(Boolean)
              .join("\n"),
          };
          const routePluginId = this.activeRoutePluginId;
          if (routePluginId === pluginId) {
            this.detail = null;
            this.context.replace("plugin-settings", {
              pathname: pathForRoute("plugin-settings", this.context.basePath),
            });
          }
        }
        await this.refreshCatalogAfterMutation(client);
      },
      { confirm: () => confirmPluginUninstall(name) },
    );
  }

  override render() {
    const blockedReason = this.mutationBlockedReason();
    return renderPluginsPage({
      context: this.context,
      routeData: this.routeData,
      surface: this.surface,
      connected: this.gateway.connected,
      loading: this.loading,
      result: this.result,
      error: this.error,
      query: this.query,
      settingsTab: this.settingsTab,
      busy: this.busy,
      messages: this.messages,
      detail: this.detail,
      pageNotice: this.pageNotice,
      iconUrls: this.iconUrls,
      catalogIconUrls: this.catalogIconUrls,
      catalogDetail: this.catalogDetail,
      catalogDetailTab: this.catalogDetailTab,
      installedDetailTab: this.installedDetailTab,
      installWizard: this.installWizard,
      canMutate: this.canMutate(),
      mutationBlockedReason: blockedReason,
      canEditConfig: this.canEditConfig(),
      discovery: this.discovery,
      consentController: this.consentController,
      installWizardController: this.installWizardController,
      actions: {
        selectHubTab: (tab) => this.selectHubTab(tab),
        closeCatalogDetail: () => this.closeCatalogDetail(),
        retryCatalogDetail: () => void this.showCatalogDetail(this.catalogDetail?.id ?? null),
        installCatalogEntry: (id) => void this.installCatalogEntry(id),
        selectCatalogDetailTab: (tab) => {
          this.catalogDetailTab = tab;
        },
        setQuery: (query) => {
          this.query = query;
        },
        refreshCatalog: () => void this.refreshCatalog(),
        openPluginSettings: (pluginId, fromDiscovery) => {
          this.context.navigate("plugin-settings", {
            pathname: pluginId
              ? pathForPluginSettings(pluginId, this.context.basePath)
              : pathForRoute("plugin-settings", this.context.basePath),
            search: fromDiscovery && pluginId ? "?from=plugins" : "",
          });
        },
        handlePluginIconError: (pluginId) => this.icons.handleInstalledError(pluginId),
        updateEnabled: (pluginId, enabled, rowKey) =>
          void this.consentController.updateEnabled(pluginId, enabled, rowKey),
        uninstall: (pluginId, rowKey) => void this.uninstall(pluginId, rowKey),
        patchConfig: (path, value) => {
          this.pluginConfigEditPending = true;
          this.context.runtimeConfig.patchForm(path, value);
        },
        removeConfig: (path) => {
          this.pluginConfigEditPending = true;
          this.context.runtimeConfig.removeFormValue(path);
        },
        reloadConfig: () => {
          this.pluginConfigEditPending = false;
          void this.context.runtimeConfig.refresh({ discardPendingChanges: true });
        },
        retryConfigRead: () => {
          void this.context.runtimeConfig.refresh();
          void this.context.runtimeConfig.refreshSchema();
        },
        retryConfigWrite: () => {
          void this.context.runtimeConfig.retry();
        },
        closeSettingsDetail: (parentRoute) => {
          this.detail = null;
          this.installedDetailTab = "readme";
          this.context.navigate(parentRoute, {
            pathname: pathForRoute(parentRoute, this.context.basePath),
          });
        },
        retrySettingsDetail: (pluginId) => void this.showDetails(pluginId),
        selectInstalledDetailTab: (tab) => {
          this.installedDetailTab = tab;
          this.context.replace("plugin-settings", {
            pathname: this.detail
              ? pathForPluginSettings(this.detail.pluginId, this.context.basePath)
              : this.routeData?.location.pathname,
            search: this.routeData?.location.search,
            hash: `#${tab}`,
          });
        },
        selectSettingsTab: (tab) => {
          this.settingsTab = tab;
          this.context.replace("plugin-settings", {
            pathname: pathForRoute("plugin-settings", this.context.basePath),
            search: tab === "advanced" ? "?tab=advanced" : "",
          });
        },
      },
    });
  }
}

if (!customElements.get("openclaw-plugins-page")) {
  customElements.define("openclaw-plugins-page", PluginsPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugins-page": PluginsPage;
  }
}

export { PluginsPage };
