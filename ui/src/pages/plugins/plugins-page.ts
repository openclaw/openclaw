import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  pathForRoute,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { isComposingKeyboardEvent } from "../../lib/ime.ts";
import {
  loadPluginDiscoveryDetail,
  uninstallPlugin,
  type PluginListResult,
  type PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { installedPluginDetailTabFromHash, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import { PluginHelpController } from "./plugin-help-controller.ts";
import { PluginMcpLoginController } from "./plugin-mcp-login-controller.ts";
import { focusHeadingAfterRemoval } from "./plugin-removal-focus.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import { PluginSettingsController } from "./plugin-settings-controller.ts";
import { pluginMutationWarnings, PluginsConsentController } from "./plugins-consent-controller.ts";
import { loadInstalledPluginDetail, loadPluginCatalogDetail } from "./plugins-detail-loader.ts";
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
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsTab } from "./settings-view.tsx";
import { PluginPreviewController } from "./skill-preview.tsx";

export class PluginsPageController implements ReactiveControllerHost {
  private readonly controllers = new Set<ReactiveController>();
  private active = false;
  element!: HTMLElement;
  routeData?: PluginsRouteData;
  surface: "discovery" | "settings" = "settings";

  constructor(
    private readonly options: {
      context: () => ApplicationContext;
      notify: () => void;
    },
  ) {}

  get context() {
    return this.options.context();
  }
  get isConnected() {
    return this.active;
  }
  addController(controller: ReactiveController) {
    this.controllers.add(controller);
    if (this.active) {
      controller.hostConnected?.();
    }
  }
  removeController(controller: ReactiveController) {
    this.controllers.delete(controller);
  }
  requestUpdate() {
    if (this.active) {
      this.options.notify();
    }
  }
  get updateComplete() {
    return Promise.resolve(true);
  }

  readonly state: {
    result: PluginListResult | null;
    error: string | null;
    query: string;
    settingsTab: PluginSettingsTab;
    busy: Record<string, PluginMutationAction>;
    messages: Record<string, PluginRowMessage>;
    detail: PluginsPageDetail | null;
    iconUrls: Record<string, string>;
    catalogIconUrls: Record<string, string>;
    pageNotice: PluginRowMessage | null;
    catalogDetail: PluginsPageCatalogDetail | null;
    installedDetailTab: InstalledPluginDetailTab;
  } = {
    result: null,
    error: null,
    query: "",
    settingsTab: "installed",
    busy: {},
    messages: {},
    detail: null,
    iconUrls: {},
    catalogIconUrls: {},
    pageNotice: null,
    catalogDetail: null,
    installedDetailTab: "readme",
  };

  setState(patch: Partial<typeof this.state>) {
    Object.assign(this.state, patch);
    this.requestUpdate();
  }

  private installRequestGeneration = 0;
  readonly help = new PluginHelpController(this);
  private configAutoSaveStatus = "idle";
  pluginConfigEditPending = false;
  private routeDataConsumed = false;
  private pluginGeneration: number | undefined;
  readonly icons = new PluginsPageIcons({
    getContext: () => this.context,
    isConnected: () => this.isConnected,
    onInstalledUrlsChange: (urls) => {
      this.setState({ iconUrls: urls });
    },
    onCatalogUrlsChange: (urls) => {
      this.setState({ catalogIconUrls: urls });
    },
    onLoadingChange: () => this.requestUpdate(),
  });
  readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.setState({ result: null });
      this.setState({ error: null });
      this.setState({ messages: {} });
      this.setState({ pageNotice: null });
    },
    invalidateRequests: (change) =>
      this.invalidateRequests(
        change.identityChanged || change.snapshot.phase !== "connected" || !change.snapshot.client,
      ),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });
  readonly skillPreview = new PluginPreviewController(this, this.gateway);
  readonly mcpLogin = new PluginMcpLoginController(this, this.gateway, {
    getDetail: () => this.state.detail,
    getName: (pluginId) =>
      this.state.result?.plugins.find((plugin) => plugin.id === pluginId)?.name,
    canSignIn: () => canCallGatewayMethod(this.gateway.snapshot, "mcp.authLogin", "operator.admin"),
    refresh: (pluginId) => this.showDetails(pluginId),
  });
  readonly discovery = new PluginDiscoveryController(this, {
    getClient: () => this.gateway.client,
    isConnected: () => this.gateway.connected,
  });
  readonly settings = new PluginSettingsController({
    gateway: this.gateway,
    getContext: () => this.context,
    getDetail: () => this.state.detail,
    canInspect: () => hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    canEdit: () => this.canEditConfig(),
    onEdit: () => {
      this.pluginConfigEditPending = true;
    },
    isSettings: () => this.state.installedDetailTab === "configuration",
  });

  readonly consentController = new PluginsConsentController({
    gateway: this.gateway,
    getContext: () => this.context,
    getResult: () => this.state.result,
    canMutate: () => this.canMutate(),
    isBusy: (rowKey) => Boolean(this.state.busy[rowKey]),
    setBusy: (rowKey, busy) => this.setBusy(rowKey, busy),
    setMessage: (rowKey, message) => this.setMessage(rowKey, message),
    getMessages: () => this.state.messages,
    clearPageNotice: () => {
      this.setState({ pageNotice: null });
    },
    closeDetails: () => this.skillPreview.close(),
    applyMutationResult: (result) => this.applyMutationResult(result),
    refreshCatalogAfterMutation: (client) => this.refreshCatalog(client),
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly catalogTask = new Task(this, {
    autoRun: false,
    task: ([client]: readonly [GatewayPageController["client"]], { signal }) =>
      client ? client.request<PluginListResult>("plugins.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.replaceResult(result);
      if (this.surface === "settings") {
        void this.showDetails(this.activeRoutePluginId);
      }
    },
    onError: (error) => {
      this.setState({ error: formatUiError(error) });
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
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

  update(routeData: PluginsRouteData | undefined, surface: "discovery" | "settings") {
    const previous = this.routeData;
    this.routeData = routeData;
    this.surface = surface;
    if (!this.active) {
      this.active = true;
      document.addEventListener("keydown", this.handleDocumentKeydown, true);
      for (const controller of this.controllers) {
        controller.hostConnected?.();
      }
    }
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
    if (previous !== routeData) {
      this.skillPreview.close();
      if (previous?.location.pathname !== routeData?.location.pathname) {
        this.installRequestGeneration += 1;
        this.mcpLogin.reset();
      }
      this.applyRouteData();
    }
    this.requestUpdate();
  }

  afterCommit() {
    this.icons.syncInstalled(this.state.result, this.element);
    this.icons.syncCatalog(
      this.discovery,
      this.element,
      this.state.detail?.catalog ?? this.state.catalogDetail?.result,
    );
  }

  dispose() {
    this.active = false;
    this.mcpLogin.reset();
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.skillPreview.close();
    this.discovery.disconnect();
    this.subscriptions.clear();
    this.icons.reset();
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.controllers.clear();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    // WebAwesome dismisses its open dropdown at document bubble. Let that
    // owner close the menu and restore focus before this page handles Escape.
    if (
      event.key !== "Escape" ||
      isComposingKeyboardEvent(event) ||
      document.querySelector(".shell-nav[aria-modal='true']") ||
      (event.target instanceof Element && event.target.closest("wa-dropdown[open]"))
    ) {
      return;
    }
    if (
      event.target instanceof Node &&
      event.target !== document &&
      event.target !== document.body &&
      !this.element.contains(event.target)
    ) {
      return;
    }
    const progress = this.element.querySelector<
      HTMLElementTagNameMap["openclaw-plugin-install-action"]
    >("openclaw-plugin-install-action[open]");
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
    this.element.querySelector<HTMLElement>(":focus")?.blur();
    if (this.state.catalogDetail) {
      this.closeCatalogDetail();
      event.stopPropagation();
      return;
    }
    if (this.state.detail) {
      this.setState({ detail: null });
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
      this.setState({ busy: {} });
    }
    if (shouldRefreshAfterChange) {
      void this.refreshCatalog();
    }
    this.ensureInitialData();
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
      this.setState({
        settingsTab:
          new URLSearchParams(data.location.search).get("tab") === "advanced"
            ? "advanced"
            : "installed",
      });
    }
    if (detailPluginId || catalogId) {
      this.setState({
        installedDetailTab:
          new URLSearchParams(data.location.search).get("view") === "settings"
            ? "configuration"
            : installedPluginDetailTabFromHash(data.location.hash),
      });
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
        this.setState({ error: data.error });
      }
    }
    if (this.surface === "settings" && detailPluginId !== this.state.detail?.pluginId) {
      void this.showDetails(detailPluginId);
    }
    if (catalogId !== this.state.catalogDetail?.id) {
      void this.showCatalogDetail(catalogId);
    }
    this.ensureInitialData();
  }

  private invalidateRequests(invalidateCatalog: boolean) {
    this.mcpLogin.reset();
    if (invalidateCatalog) {
      void this.catalogTask.run([null]);
      this.discovery.invalidate();
    }
    this.skillPreview.close();
    // Inspection results belong to one connection epoch, including same-client reconnects.
    this.setState({ detail: null });
    this.setState({ catalogDetail: null });
    this.installRequestGeneration += 1;
    this.consentController.reset();
  }

  private replaceResult(result: PluginListResult | null) {
    // Uninstall publishes generations before its final result. Keep the selected
    // view intact until settlement refreshes inventory and retires its detail.
    if (this.uninstallingSelection) {
      return;
    }
    if (
      this.state.detail &&
      result &&
      !result.plugins.some(
        (plugin) => plugin.id === this.state.detail?.pluginId && plugin.installed,
      )
    ) {
      // A late removal failure must survive the disappearance of its row.
      this.setState({
        pageNotice:
          this.state.messages[pluginRowKey(this.state.detail.pluginId)] ?? this.state.pageNotice,
      });
    }
    // Route changes reuse artwork; a new Gateway plugin generation retires it.
    if (this.state.result?.generation === result?.generation) {
      this.icons.installed.reconcile(result);
    } else {
      this.icons.installed.reset();
    }
    this.setState({ messages: this.consentController.reconcileInstallMessages(result) });
    this.setState({ result });
    // Both route loading and explicit refreshes publish the installed inventory.
    // Retire any earlier catalog request before resolving its local identity.
    if (result && this.surface === "discovery") {
      void this.refreshDiscovery();
    }
  }

  get loading(): boolean {
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

  private get uninstallingSelection(): boolean {
    return Boolean(
      this.state.detail &&
      this.state.busy[pluginRowKey(this.state.detail.pluginId)] === "uninstall" &&
      this.activeRoutePluginId ===
        (this.surface === "settings" ? this.state.detail.pluginId : this.state.catalogDetail?.id),
    );
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
    // A settings page can mount before connection; admit its reads through
    // both route changes and connected snapshots, including Advanced.
    if (
      this.surface === "settings" ||
      (this.activeRoutePluginId && this.state.installedDetailTab === "configuration")
    ) {
      void this.context.runtimeConfig.ensureLoaded();
      void this.context.runtimeConfig.ensureSchemaLoaded();
    }
    if (!this.loading && !this.state.result && !this.state.error) {
      void this.refreshCatalog();
    }
  }

  async refreshCatalog(client = this.gateway.connected ? this.gateway.client : null) {
    if (!client) {
      return;
    }
    this.setState({ error: null });
    await this.catalogTask.run([client]);
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.surface !== "discovery") {
      return;
    }
    const catalogId = this.activeRoutePluginId;
    return catalogId ? this.showCatalogDetail(catalogId) : this.discovery.refresh();
  }

  selectHubTab(tab: PluginsHubTab) {
    if (tab !== "plugins" || this.surface !== "discovery") {
      this.context.navigate(tab);
    }
  }

  accessBlockedReason(
    mutationAllowed?: boolean,
    connected = this.gateway.connected,
  ): string | null {
    return pluginMutationBlockedReason({
      connected,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      mutationAllowed,
    });
  }

  canMutate(): boolean {
    return this.state.result?.mutationAllowed === true && this.accessBlockedReason() === null;
  }

  canEditConfig(): boolean {
    const runtimeConfig = this.context.runtimeConfig;
    return this.accessBlockedReason(runtimeConfig.canSet, runtimeConfig.state.connected) === null;
  }

  private setBusy(key: string, value: PluginMutationAction | null) {
    const uninstallChanged = value === "uninstall" || this.state.busy[key] === "uninstall";
    const next = { ...this.state.busy };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.setState({ busy: next });
    if (uninstallChanged && this.state.detail && key === pluginRowKey(this.state.detail.pluginId)) {
      // Retire reads admitted before removal. A failed uninstall refreshes the
      // surviving plugin; success clears its detail before refreshing inventory.
      if (value === "uninstall") {
        this.setState({
          catalogDetail: this.state.catalogDetail ? { ...this.state.catalogDetail } : null,
        });
        void this.showDetails(this.state.detail.pluginId);
      } else {
        void this.refreshCatalog();
      }
    }
  }

  private setMessage(key: string, message: PluginRowMessage | null) {
    const next = { ...this.state.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.setState({ messages: next });
  }

  private applyMutationResult(result: PluginMutationResult) {
    this.icons.installed.invalidate(result.plugin.id);
    this.replaceResult(mergePluginCatalogItem(this.state.result, result.plugin));
  }

  showDetails(pluginId: string | null) {
    this.mcpLogin.select(pluginId);
    return loadInstalledPluginDetail({
      pluginId,
      plugin: this.state.result?.plugins.find((entry) => entry.id === pluginId),
      catalog: this.state.catalogDetail?.result,
      gateway: this.gateway,
      canInspect: !pluginId || this.state.busy[pluginRowKey(pluginId)] !== "uninstall",
      getDetail: () => this.state.detail,
      onChange: (detail) => {
        this.setState({ detail });
      },
    });
  }

  async showCatalogDetail(id: string | null) {
    if (this.surface !== "discovery") {
      this.setState({ catalogDetail: null });
      return;
    }
    return loadPluginCatalogDetail({
      id,
      gateway: this.gateway,
      context: this.context,
      location: this.routeData?.location,
      inventory: this.state.result,
      uninstalling: this.uninstallingSelection,
      getDetail: () => this.state.catalogDetail,
      onChange: (detail) => {
        this.setState({ catalogDetail: detail });
      },
      showInstalled: (pluginId) => this.showDetails(pluginId),
    });
  }

  async installCatalogEntry(id: string): Promise<void> {
    const scope = this.gateway.capture();
    const key = `install:${id}`;
    if (!scope || !this.canMutate() || this.state.busy[key]) {
      return;
    }
    const generation = ++this.installRequestGeneration;
    this.setBusy(key, "install");
    try {
      const result =
        this.state.catalogDetail?.result?.plugin.id === id
          ? this.state.catalogDetail.result
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

  closeCatalogDetail() {
    this.setState({ catalogDetail: null });
    this.setState({ detail: null });
    this.context.navigate("plugins", {
      pathname: pathForRoute("plugins", this.context.basePath),
    });
  }

  async uninstall(pluginId: string, rowKey: string): Promise<void> {
    const name =
      this.state.result?.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
    const trigger = this.element.contains(document.activeElement) ? document.activeElement : null;
    await this.consentController.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, isLatest) => {
        if (this.state.detail?.pluginId === pluginId) {
          this.setState({ detail: null });
        }
        // Removal hides its row; any remaining warning belongs to the page.
        if (isLatest()) {
          this.setState({ pageNotice: pluginMutationWarnings(result, refreshError) });
          const routePluginId = this.activeRoutePluginId;
          if (routePluginId === pluginId) {
            this.context.replace("plugin-settings", {
              pathname: pathForRoute("plugin-settings", this.context.basePath),
            });
          }
        }
        await this.refreshCatalog(client);
        if (isLatest()) {
          await this.updateComplete;
          focusHeadingAfterRemoval(this.element, trigger);
        }
      },
      {
        action: "uninstall",
        confirm: () =>
          showConfirmDialog({
            title: t("pluginsPage.removeConfirmTitle", { name }),
            message: t("pluginsPage.removeConfirmMessage"),
            confirmLabel: t("pluginsPage.remove"),
            danger: true,
          }),
      },
    );
  }
}
