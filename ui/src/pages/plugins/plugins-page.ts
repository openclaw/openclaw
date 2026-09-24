import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  pathForPluginSettings,
  pathForRoute,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
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
import {
  pluginDetailLocation,
  installedPluginDetailTabFromHash,
  type InstalledPluginDetailTab,
} from "./detail-tabs.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import { PluginHelpController } from "./plugin-help-controller.ts";
import { confirmPluginUninstall } from "./plugin-lifecycle-confirmation.ts";
import type { PluginRowMessage } from "./plugin-row-message.ts";
import { PluginSettingsController } from "./plugin-settings-controller.ts";
import { pluginMutationWarnings, PluginsConsentController } from "./plugins-consent-controller.ts";
import { loadInstalledPluginDetail } from "./plugins-detail-loader.ts";
import type { PluginsHubTab } from "./plugins-hub.ts";
import { PluginsPageIcons } from "./plugins-page-icons.ts";
import {
  installRequestForDiscoveryDetail,
  mergePluginCatalogItem,
  pluginMutationBlockedReason,
  type PluginMutationAction,
  type PluginsPageCatalogDetail,
  type PluginsPageDetail,
} from "./plugins-page-model.ts";
import { renderPluginsPage } from "./plugins-page-view.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsTab } from "./settings-view.ts";
import { PluginPreviewController } from "./skill-preview.ts";

class PluginsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: PluginsRouteData;
  @property({ attribute: false }) surface: "discovery" | "settings" = "settings";

  @state() private result: PluginListResult | null = null;
  @state() private error: string | null = null;
  @state() private query = "";
  @state() private settingsTab: PluginSettingsTab = "installed";
  @state() private busy: Record<string, PluginMutationAction> = {};
  @state() private messages: Record<string, PluginRowMessage> = {};
  @state() private detail: PluginsPageDetail | null = null;
  @state() private iconUrls: Record<string, string> = {};
  @state() private catalogIconUrls: Record<string, string> = {};
  @state() private pageNotice: PluginRowMessage | null = null;
  @state() private catalogDetail: PluginsPageCatalogDetail | null = null;
  @state() private installedDetailTab: InstalledPluginDetailTab = "readme";
  private installRequestGeneration = 0;
  private readonly help = new PluginHelpController(this);
  private configAutoSaveStatus = this.context?.runtimeConfig.state.configAutoSaveStatus ?? "idle";
  private pluginConfigEditPending = false;
  private routeDataConsumed = false;
  private pluginGeneration: number | undefined;
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
      this.result = null;
      this.error = null;
      this.messages = {};
      this.pageNotice = null;
    },
    invalidateRequests: (change) =>
      this.invalidateRequests(
        change.identityChanged || change.snapshot.phase !== "connected" || !change.snapshot.client,
      ),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });
  private readonly skillPreview = new PluginPreviewController(this, this.gateway);
  private readonly discovery = new PluginDiscoveryController(this, {
    getClient: () => this.gateway.client,
    isConnected: () => this.gateway.connected,
  });
  private readonly settings = new PluginSettingsController({
    gateway: this.gateway,
    getContext: () => this.context,
    getDetail: () => this.detail,
    canInspect: () => hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    canEdit: () => this.canEditConfig(),
    onEdit: () => {
      this.pluginConfigEditPending = true;
    },
    isSettings: () => this.installedDetailTab === "configuration",
  });

  private readonly consentController = new PluginsConsentController({
    gateway: this.gateway,
    getContext: () => this.context,
    getResult: () => this.result,
    canMutate: () => this.canMutate(),
    isBusy: (rowKey) => Boolean(this.busy[rowKey]),
    setBusy: (rowKey, busy) => this.setBusy(rowKey, busy),
    setMessage: (rowKey, message) => this.setMessage(rowKey, message),
    getMessages: () => this.messages,
    clearPageNotice: () => {
      this.pageNotice = null;
    },
    closeDetails: () => this.skillPreview.close(),
    applyMutationResult: (result) => this.applyMutationResult(result),
    refreshCatalogAfterMutation: (client) => this.refreshCatalog(client),
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly catalogTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client ? client.request<PluginListResult>("plugins.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.replaceResult(result);
      if (this.surface === "settings") {
        void this.showDetails(this.activeRoutePluginId);
      }
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      if (this.surface === "settings") {
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
          void this.refreshCatalog();
        }
      });
    },
  );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.skillPreview.close();
      if (changed.get("routeData")?.location.pathname !== this.routeData?.location.pathname) {
        this.installRequestGeneration += 1;
      }
      this.applyRouteData();
    }
  }

  override updated() {
    this.icons.syncInstalled(this.result, this);
    // Fetch only rendered cards after Lit applies the current section/filter state.
    this.icons.syncCatalog(
      this.discovery,
      this,
      this.detail?.catalog ?? this.catalogDetail?.result,
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.skillPreview.close();
    this.discovery.disconnect();
    this.subscriptions.clear();
    this.icons.reset();
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    // WebAwesome dismisses its open dropdown at document bubble. Let that
    // owner close the menu and restore focus before this page handles Escape.
    if (
      event.key !== "Escape" ||
      document.querySelector(".shell-nav[aria-modal='true']") ||
      (event.target instanceof Element && event.target.closest("wa-dropdown[open]"))
    ) {
      return;
    }
    const progress = this.querySelector<HTMLElementTagNameMap["openclaw-plugin-install-action"]>(
      "openclaw-plugin-install-action[open]",
    );
    if (progress) {
      progress.dismiss();
      event.stopPropagation();
      return;
    }
    if (this.consentController.consent) {
      this.consentController.close();
      event.stopPropagation();
      return;
    }
    // The file viewer owns Escape inside its shadow-root modal.
    if (this.skillPreview.state || document.querySelector("openclaw-modal-dialog")) {
      return;
    }
    // Firefox does not emit blur when a focused input is removed from the document.
    this.querySelector<HTMLElement>(":focus")?.blur();
    if (this.catalogDetail) {
      this.closeCatalogDetail();
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
    }
  };

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    const generation = snapshot.pluginCapabilities?.generation;
    const pluginsChanged = generation !== undefined && generation !== this.pluginGeneration;
    this.pluginGeneration = generation;
    if (!change.initial && pluginsChanged) {
      this.skillPreview.close();
    }
    const iconAuthChanged = this.icons.updateAuth({
      hello: snapshot.hello,
      settings: { token: this.context.gateway.connection.token },
      password: this.context.gateway.connection.password,
    });
    const shouldRefreshAfterChange =
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged || pluginsChanged) &&
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
      if (this.surface === "discovery" && !this.activeRoutePluginId) {
        void this.discovery.ensureCategories();
      }
      void this.refreshCatalog();
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
    if (detailPluginId || catalogId) {
      this.installedDetailTab =
        new URLSearchParams(data.location.search).get("view") === "settings"
          ? "configuration"
          : installedPluginDetailTabFromHash(data.location.hash);
    }
    if (this.gateway.isRouteDataCurrent(data)) {
      // Route loading can complete after publication on the same connection.
      if (
        this.pluginGeneration !== undefined &&
        (data.result?.generation ?? -1) < this.pluginGeneration
      ) {
        void this.refreshCatalog();
      } else {
        this.replaceResult(data.result);
        this.error = data.error;
      }
    }
    if (this.surface === "settings" && detailPluginId !== this.detail?.pluginId) {
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
    this.skillPreview.close();
    // Inspection results belong to one connection epoch, including same-client reconnects.
    this.detail = null;
    this.catalogDetail = null;
    this.installRequestGeneration += 1;
    this.consentController.reset();
  }

  private replaceResult(result: PluginListResult | null, preserveIcons = false) {
    if (preserveIcons) {
      this.icons.reconcileInstalled(result);
    } else {
      this.icons.resetInstalled();
    }
    this.messages = this.consentController.reconcileInstallMessages(result);
    this.result = result;
    // Both route loading and explicit refreshes publish the installed inventory.
    // Retire any earlier catalog request before resolving its local identity.
    if (result && this.surface === "discovery") {
      void this.refreshDiscovery();
    }
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
    // Category navigation needs neither installed inventory nor catalog cards.
    // Start it as soon as this discovery page has a connection, even while the
    // route's plugins.list request is pending.
    if (this.surface === "discovery" && !this.activeRoutePluginId) {
      void this.discovery.ensureCategories();
    }
    // The route owns initial loading; a warm page module can render before its data arrives.
    if (!this.routeDataConsumed || !this.gateway.connected || !this.gateway.client) {
      return;
    }
    // Direct links and refreshes initialize Settings through the same route
    // lifecycle as navigation; the click handler only selects the location.
    if (this.activeRoutePluginId && this.installedDetailTab === "configuration") {
      void this.context.runtimeConfig.ensureLoaded();
      void this.context.runtimeConfig.ensureSchemaLoaded();
    }
    if (!this.loading && !this.result && !this.error) {
      void this.refreshCatalog();
    }
  }

  private async refreshCatalog(client = this.gateway.connected ? this.gateway.client : null) {
    if (!client) {
      return;
    }
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.surface !== "discovery") {
      return;
    }
    const catalogId = this.activeRoutePluginId;
    if (catalogId) {
      await this.showCatalogDetail(catalogId);
    } else {
      await this.discovery.refresh();
    }
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab !== "plugins" || this.surface !== "discovery") {
      this.context.navigate(tab);
    }
  }

  private accessBlockedReason(
    mutationAllowed?: boolean,
    connected = this.gateway.connected,
  ): string | null {
    return pluginMutationBlockedReason({
      connected,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      mutationAllowed,
    });
  }

  private canMutate(): boolean {
    return this.result?.mutationAllowed === true && this.accessBlockedReason() === null;
  }

  private canEditConfig(): boolean {
    const runtimeConfig = this.context.runtimeConfig;
    return this.accessBlockedReason(runtimeConfig.canSet, runtimeConfig.state.connected) === null;
  }

  private setBusy(key: string, value: PluginMutationAction | null) {
    const next = { ...this.busy };
    if (value) {
      next[key] = value;
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

  private async showDetails(pluginId: string | null) {
    // Refresh the same plugin without retiring focused controls or open groups.
    // Connection changes and navigation clear detail before reaching this owner.
    const previous = this.detail?.pluginId === pluginId ? this.detail : null;
    const catalog = this.catalogDetail?.result;
    const plugin = this.result?.plugins.find((entry) => entry.id === pluginId);
    let detail: PluginsPageDetail | null = pluginId
      ? {
          ...previous,
          pluginId,
          inspection: previous?.inspection ?? null,
          catalog:
            previous?.catalog ??
            (catalog && catalog.plugin.id === plugin?.catalogId ? catalog : undefined),
          error: null,
        }
      : null;
    this.detail = detail;
    const scope = this.gateway.capture();
    if (!plugin?.installed || !detail || !scope) {
      return;
    }
    await loadInstalledPluginDetail({
      plugin,
      client: scope.client,
      initial: detail,
      includeTools:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "tools.catalog") === true,
      isCurrent: () => this.gateway.isCurrent(scope) && this.detail === detail,
      onChange: (next) => {
        detail = next;
        this.detail = next;
      },
    });
  }

  private async showCatalogDetail(id: string | null) {
    // Same-selection refreshes retain presentation; a new object fences older requests.
    const detail = id
      ? {
          id,
          result: this.catalogDetail?.id === id ? this.catalogDetail.result : null,
          error: null,
        }
      : null;
    if (this.surface === "discovery" && this.catalogDetail?.id !== id) {
      this.detail = null;
    }
    this.catalogDetail = detail;
    const scope = this.gateway.capture();
    if (!detail || !scope) {
      return;
    }
    const installed = this.result?.plugins.find(
      (plugin) => plugin.installed && plugin.catalogId === id,
    );
    if (installed) {
      // Installed identity and availability belong to the local inventory. Its
      // detail loader enriches the overview without waiting on ClawHub.
      if (new URLSearchParams(this.routeData?.location.search).get("action") === "install") {
        this.context.replace("plugins", {
          pathname: this.routeData?.location.pathname,
          search: "",
        });
      }
      await this.showDetails(installed.id);
      return;
    }
    this.detail = null;
    try {
      const result = await loadPluginDiscoveryDetail(scope.client, detail.id);
      if (this.gateway.isCurrent(scope) && this.catalogDetail === detail) {
        this.catalogDetail = { ...detail, result };
        const installedId = result.plugin.local.installed
          ? result.plugin.local.pluginId
          : undefined;
        void this.showDetails(installedId ?? null);
        if (new URLSearchParams(this.routeData?.location.search).get("action") === "install") {
          // A link selects the plugin; installation still requires an explicit button click.
          this.context.replace("plugins", {
            pathname: this.routeData?.location.pathname,
            search: "",
          });
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
    const key = `install:${id}`;
    if (!scope || !this.canMutate() || this.busy[key]) {
      return;
    }
    const generation = ++this.installRequestGeneration;
    this.setBusy(key, "install");
    try {
      const result =
        this.catalogDetail?.result?.plugin.id === id
          ? this.catalogDetail.result
          : await loadPluginDiscoveryDetail(scope.client, id);
      if (!this.gateway.isCurrent(scope) || generation !== this.installRequestGeneration) {
        return;
      }
      const request = installRequestForDiscoveryDetail(result);
      this.setBusy(key, null);
      if (request) {
        await this.consentController.install(request, key);
      } else {
        this.setMessage(key, {
          kind: "warning",
          text: t("pluginsPage.installAvailabilityChanged"),
        });
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && generation === this.installRequestGeneration) {
        this.setMessage(key, { kind: "error", text: formatUiError(error) });
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.setBusy(key, null);
      }
    }
  }

  private closeCatalogDetail() {
    this.catalogDetail = null;
    this.detail = null;
    this.context.navigate("plugins", {
      pathname: pathForRoute("plugins", this.context.basePath),
    });
  }

  private async uninstall(pluginId: string, rowKey: string): Promise<void> {
    const name = this.result?.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
    await this.consentController.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, _isCurrent, isLatest) => {
        // Removal hides its row; any remaining warning belongs to the page.
        if (isLatest()) {
          this.pageNotice = pluginMutationWarnings(result, refreshError);
          const routePluginId = this.activeRoutePluginId;
          if (routePluginId === pluginId) {
            this.detail = null;
            this.context.replace("plugin-settings", {
              pathname: pathForRoute("plugin-settings", this.context.basePath),
            });
          }
        }
        await this.refreshCatalog(client);
      },
      { action: "uninstall", confirm: () => confirmPluginUninstall(name) },
    );
  }

  override render() {
    const blockedReason = this.accessBlockedReason(this.result?.mutationAllowed);
    return renderPluginsPage({
      help: this.help,
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
      installedDetailTab: this.installedDetailTab,
      canMutate: this.canMutate(),
      mutationBlockedReason: blockedReason,
      canEditConfig: this.canEditConfig(),
      discovery: this.discovery,
      consentController: this.consentController,
      renderCredential: this.settings.render,
      skillPreview: this.skillPreview,
      actions: {
        selectHubTab: (tab) => this.selectHubTab(tab),
        closeCatalogDetail: () => this.closeCatalogDetail(),
        retryCatalogDetail: () => void this.showCatalogDetail(this.catalogDetail?.id ?? null),
        installCatalogEntry: (id) => void this.installCatalogEntry(id),
        openSkill: (request) => void this.skillPreview.open(request),
        openTool: (name) =>
          this.skillPreview.openTool(
            this.detail?.tools?.find((entry) => entry.name === name) ?? { name },
          ),
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
          void this.consentController.mutateInstalledPlugin(
            pluginId,
            enabled ? "enable" : "disable",
            rowKey,
          ),
        uninstall: (pluginId, rowKey) => void this.uninstall(pluginId, rowKey),
        patchConfig: (path, value) => this.settings.patch(path, value),
        removeConfig: (path) => this.settings.patch(path, undefined),
        reloadConfig: () => {
          this.pluginConfigEditPending = false;
          void this.context.runtimeConfig.discardDraft({ reloadOnly: true });
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
          this.context.navigate(
            this.surface === "discovery" ? "plugins" : "plugin-settings",
            pluginDetailLocation(this.routeData?.location, tab === "configuration"),
          );
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
