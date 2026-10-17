import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import {
  pathForRoute,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { registryFor } from "../../components/overlay-registry.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { isComposingKeyboardEvent } from "../../lib/ime.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import {
  loadPluginDiscoveryDetail,
  uninstallPlugin,
  type PluginListResult,
  type PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { PluginCredentialEditorProps } from "./credential-editor.tsx";
import { installedPluginDetailTabFromHash, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import { createPluginDiscovery } from "./plugin-discovery.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createPluginMcpLogin } from "./plugin-mcp-login.ts";
import { focusHeadingAfterRemoval } from "./plugin-removal-focus.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import { pluginMutationWarnings, createPluginsConsent } from "./plugins-consent.ts";
import { loadInstalledPluginDetail, loadPluginCatalogDetail } from "./plugins-detail-loader.ts";
import type { PluginsHubTab } from "./plugins-hub.ts";
import { createPluginsPageIcons } from "./plugins-page-icons.ts";
import {
  installRequestForDiscoveryDetail,
  mergePluginCatalogItem,
  pluginMutationBlockedReason,
  type PluginMutationAction,
  type PluginsPageCatalogDetail,
  type PluginsPageDetail,
} from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";
import type { PluginSettingsTab } from "./settings-view.tsx";
import { createPluginPreview } from "./skill-preview.tsx";

export function createPluginsPage(options: {
  context: ApplicationContext;
  element: () => HTMLElement;
  routeData: () => PluginsRouteData | undefined;
  surface: () => "discovery" | "settings";
}) {
  const context = options.context;
  let active = true;
  let routeData: PluginsRouteData | undefined;
  let surface: "discovery" | "settings" = "settings";
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [settingsTab, setSettingsTab] = createSignal<PluginSettingsTab>("installed");

  const state: {
    result: PluginListResult | null;
    error: string | null;
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
    busy: {},
    messages: {},
    detail: null,
    iconUrls: {},
    catalogIconUrls: {},
    pageNotice: null,
    catalogDetail: null,
    installedDetailTab: "readme",
  };

  function read() {
    revision();
    return state;
  }

  function publish() {
    if (active) {
      setRevision((previous) => previous + 1);
    }
  }

  function setState(patch: Partial<typeof state>) {
    if (!active) {
      return;
    }
    Object.assign(state, patch);
    publish();
  }

  let installRequestGeneration = 0;
  const help = createPluginHelp(context);
  let pluginConfigEditPending = false;
  let routeDataConsumed = false;
  let pluginGeneration: number | undefined;
  let adminAccess: boolean | undefined;
  let readAccess: boolean | undefined;
  const icons = createPluginsPageIcons({
    getContext: () => context,
    isConnected: () => active,
    onInstalledUrlsChange: (urls) => setState({ iconUrls: urls }),
    onCatalogUrlsChange: (urls) => setState({ catalogIconUrls: urls }),
    onChange: publish,
  });
  const gateway = new GatewayPageBinding(publish, {
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      adminAccess = undefined;
      readAccess = undefined;
      setState({ result: null, error: null, messages: {}, pageNotice: null });
    },
    invalidateRequests: (change) =>
      active &&
      invalidateRequests(
        change.identityChanged || change.snapshot.phase !== "connected" || !change.snapshot.client,
        change.identityChanged,
      ),
    onSnapshot: handleGatewaySnapshot,
  });
  const skillPreview = createPluginPreview(gateway, publish);
  const mcpLogin = createPluginMcpLogin(gateway, {
    getDetail: () => state.detail,
    getName: (pluginId) => state.result?.plugins.find((plugin) => plugin.id === pluginId)?.name,
    canSignIn: () => canCallGatewayMethod(gateway.snapshot, "mcp.authLogin", "operator.admin"),
    refresh: showDetails,
  });
  const discovery = createPluginDiscovery(
    {
      getClient: () => gateway.client,
      isConnected: () => gateway.connected,
    },
    publish,
  );
  let write: Promise<boolean> | undefined;
  const patch = (path: Array<string | number>, value: unknown): boolean => {
    if (!canEditConfig()) {
      return false;
    }
    pluginConfigEditPending = true;
    const runtime = context.runtimeConfig;
    if (value === undefined) {
      runtime.removeFormValue(path);
    } else {
      runtime.patchForm(path, value);
    }
    if (state.detail && state.installedDetailTab === "configuration") {
      write = runtime.flushFormChanges();
    }
    return true;
  };

  const resolveCredential = (
    field: PluginSettingsField,
  ): PluginCredentialEditorProps | undefined => {
    const detail = state.detail;
    const descriptor = detail?.inspection?.credentials?.find(
      (entry) =>
        entry.path.length === field.path.length &&
        entry.path.every((segment, index) => segment === field.path[index]),
    );
    if (!detail || !descriptor) {
      return undefined;
    }
    const runtime = context.runtimeConfig;
    return {
      field,
      descriptor,
      context: {
        pluginId: detail.pluginId,
        baseHash: runtime.state.configSnapshot?.hash ?? null,
        gateway,
        canInspect: hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null),
        saveError: runtime.state.lastError,
        onDiscard: () => runtime.discardFormValue(field.path),
        onCommit: async (path, value) => {
          const previous = write;
          const accepted = field.onPatch(path, value);
          // Nested drafts may accept an edit without publishing a complete value.
          // Only the flush captured by this edit can acknowledge its persistence.
          return accepted !== false && write && write !== previous ? write : false;
        },
      },
    };
  };
  const settings = { patch, resolveCredential };

  const consent = createPluginsConsent({
    gateway,
    getContext: () => context,
    getResult: () => state.result,
    canMutate,
    isBusy: (rowKey) => Boolean(state.busy[rowKey]),
    setBusy,
    setMessage,
    getMessages: () => state.messages,
    clearPageNotice: () => {
      setState({ pageNotice: null });
    },
    closeDetails: skillPreview.close,
    applyMutationResult,
    refreshCatalogAfterMutation: refreshCatalog,
    onChange: publish,
  });
  const catalogTask = createPageRequest(publish, {
    task: ([client]: readonly [NonNullable<GatewayPageBinding["client"]>], { signal }) =>
      client.request<PluginListResult>("plugins.list", {}, { signal }),
    onComplete: (result) => {
      replaceResult(result);
      if (surface === "settings") {
        void showDetails(activeRoutePluginId());
      }
    },
    onError: (error) => setState({ error: formatUiError(error) }),
  });
  onCleanup(catalogTask.cancel);

  onSettled(() => {
    const runtimeConfig = context.runtimeConfig;
    let configAutoSaveStatus = runtimeConfig.state.configAutoSaveStatus;
    // Preserve saving-to-saved receipts so plugin edits refresh the catalog even within one render turn.
    return runtimeConfig.subscribe(() => {
      const nextStatus = runtimeConfig.state.configAutoSaveStatus;
      const completedSave = configAutoSaveStatus === "saving" && nextStatus === "saved";
      configAutoSaveStatus = nextStatus;
      publish();
      if (completedSave && pluginConfigEditPending) {
        pluginConfigEditPending = false;
        void refreshCatalog();
      }
    });
  });

  // Route changes synchronize the Gateway binding and retire page requests.
  createEffect(
    () => [options.routeData(), options.surface()] as const,
    ([nextRouteData, nextSurface]) => {
      const previous = routeData;
      routeData = nextRouteData;
      surface = nextSurface;
      gateway.refresh();
      if (previous !== routeData) {
        skillPreview.close();
        if (previous?.location.pathname !== routeData?.location.pathname) {
          installRequestGeneration += 1;
          mcpLogin.reset();
        }
        applyRouteData();
      }
      publish();
    },
  );

  // Track live tile identities before synchronizing the shared fetch/cache owners.
  createEffect(
    () => {
      revision();
      return icons.rendered();
    },
    (rendered) =>
      icons.sync(
        state.result,
        discovery.read(),
        rendered,
        state.detail?.catalog ?? state.catalogDetail?.result,
      ),
  );
  onSettled(() => {
    const stopKeydown = listen(document, "keydown", handleDocumentKeydown, true);
    return () => {
      stopKeydown();
      active = false;
      icons.reset();
      gateway.dispose();
    };
  });

  const handleDocumentKeydown = (event: Event) => {
    // Overlay owners handle Escape after document capture and restore focus.
    if (
      !(event instanceof KeyboardEvent) ||
      event.key !== "Escape" ||
      isComposingKeyboardEvent(event) ||
      document.querySelector(".shell-nav[aria-modal='true']") ||
      registryFor(document).stack.at(-1)?.open
    ) {
      return;
    }
    if (
      event.target instanceof Node &&
      event.target !== document &&
      event.target !== document.body &&
      !options.element().contains(event.target)
    ) {
      return;
    }
    const progress = options
      .element()
      .querySelector<HTMLElementTagNameMap["openclaw-plugin-install-action"]>(
        "openclaw-plugin-install-action[open]",
      );
    if (progress) {
      progress.dismiss();
      event.stopPropagation();
      return;
    }
    if (consent.read().consent) {
      consent.close();
      event.stopPropagation();
      return;
    }
    // The file viewer owns Escape inside its shadow-root modal.
    if (skillPreview.state || document.querySelector("openclaw-modal-dialog")) {
      return;
    }
    // Firefox does not emit blur when a focused input is removed from the document.
    options.element().querySelector<HTMLElement>(":focus")?.blur();
    if (state.catalogDetail) {
      closeCatalogDetail();
      event.stopPropagation();
      return;
    }
    if (state.detail) {
      setState({ detail: null });
      if (surface === "settings") {
        context.replace("plugin-settings", {
          pathname: pathForRoute("plugin-settings", context.basePath),
        });
      }
      event.stopPropagation();
    }
  };

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    if (snapshot.phase === "connected") {
      const allowed = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
      const canRead = hasOperatorReadAccess(snapshot.hello?.auth ?? null);
      if ((adminAccess && !allowed) || (readAccess && !canRead)) {
        gateway.invalidate();
        invalidateRequests(true);
        if (!canRead) {
          setState({ result: null, error: null, messages: {}, pageNotice: null });
        }
      }
      adminAccess = allowed;
      readAccess = canRead;
    }
    const generation = snapshot.pluginCapabilities?.generation;
    const pluginsChanged = generation !== undefined && generation !== pluginGeneration;
    pluginGeneration = generation;
    if (!change.initial && pluginsChanged) {
      skillPreview.close();
    }
    const iconAuthChanged = icons.updateAuth({
      hello: snapshot.hello,
      settings: { token: context.gateway.connection.token },
      password: context.gateway.connection.password,
    });
    const shouldRefreshAfterChange =
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged || pluginsChanged) &&
      snapshot.phase === "connected" &&
      routeDataConsumed;
    if (
      !change.initial &&
      iconAuthChanged &&
      !change.identityChanged &&
      !change.connectionChanged
    ) {
      gateway.invalidate();
      invalidateRequests(snapshot.phase !== "connected" || !snapshot.client);
    }
    if (
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged)
    ) {
      icons.reset();
      setState({ busy: {} });
    }
    if (shouldRefreshAfterChange) {
      void refreshCatalog();
    }
    ensureInitialData();
  }

  function applyRouteData() {
    const data = routeData;
    if (!data) {
      return;
    }
    routeDataConsumed = true;
    const detailPluginId = surface === "settings" ? activeRoutePluginId() : null;
    const catalogId = surface === "discovery" ? activeRoutePluginId() : null;
    // Route location is UI state, not Gateway data. Apply it even when the
    // catalog snapshot is stale so deep links do not fall back to Installed.
    if (surface === "settings" && !detailPluginId) {
      setSettingsTab(
        new URLSearchParams(data.location.search).get("tab") === "advanced"
          ? "advanced"
          : "installed",
      );
    }
    if (detailPluginId || catalogId) {
      setState({
        installedDetailTab:
          new URLSearchParams(data.location.search).get("view") === "settings"
            ? "configuration"
            : installedPluginDetailTabFromHash(data.location.hash),
      });
    }
    if (readAccess === false) {
      return;
    }
    if (gateway.isRouteDataCurrent(data)) {
      // Route loading can complete after publication on the same connection.
      if (pluginGeneration !== undefined && (data.result?.generation ?? -1) < pluginGeneration) {
        void refreshCatalog();
      } else {
        replaceResult(data.result);
        setState({ error: data.error });
      }
    }
    if (surface === "settings" && detailPluginId !== state.detail?.pluginId) {
      void showDetails(detailPluginId);
    }
    if (catalogId !== state.catalogDetail?.id) {
      void showCatalogDetail(catalogId);
    }
    ensureInitialData();
  }

  function invalidateRequests(invalidateCatalog: boolean, retirePresentation = true) {
    mcpLogin.reset();
    if (invalidateCatalog) {
      catalogTask.reset();
      discovery.invalidate();
    }
    skillPreview.close();
    if (retirePresentation) {
      setState({ detail: null, catalogDetail: null });
    }
    installRequestGeneration += 1;
    consent.reset();
  }

  function replaceResult(result: PluginListResult | null) {
    // Uninstall publishes generations before its final result. Keep the selected
    // view intact until settlement refreshes inventory and retires its detail.
    if (uninstallingSelection()) {
      return;
    }
    if (
      state.detail &&
      result &&
      !result.plugins.some((plugin) => plugin.id === state.detail?.pluginId && plugin.installed)
    ) {
      // A late removal failure must survive the disappearance of its row.
      setState({
        pageNotice: state.messages[pluginRowKey(state.detail.pluginId)] ?? state.pageNotice,
      });
    }
    // Route changes reuse artwork; a new Gateway plugin generation retires it.
    if (state.result?.generation === result?.generation) {
      icons.installed.reconcile(result);
    } else {
      icons.installed.reset();
    }
    setState({ messages: consent.reconcileInstallMessages(result) });
    setState({ result });
    // Both route loading and explicit refreshes publish the installed inventory.
    // Retire any earlier catalog request before resolving its local identity.
    if (result && surface === "discovery") {
      void refreshDiscovery();
    }
  }

  function loading(): boolean {
    return gateway.connected && (!routeDataConsumed || catalogTask.pending);
  }

  function activeRoutePluginId(): string | null {
    const pathname = routeData?.location.pathname ?? "";
    return surface === "settings"
      ? pluginSettingsIdFromPath(pathname, context.basePath)
      : pluginCatalogIdFromPath(pathname, context.basePath);
  }

  function uninstallingSelection(): boolean {
    return Boolean(
      state.detail &&
      state.busy[pluginRowKey(state.detail.pluginId)] === "uninstall" &&
      activeRoutePluginId() ===
        (surface === "settings" ? state.detail.pluginId : state.catalogDetail?.id),
    );
  }

  function ensureInitialData() {
    if (readAccess === false) {
      return;
    }
    // Category navigation needs neither installed inventory nor catalog cards.
    // Start it as soon as this discovery page has a connection, even while the
    // route's plugins.list request is pending.
    if (surface === "discovery" && !activeRoutePluginId()) {
      void discovery.ensureCategories();
    }
    // The route owns initial loading; a warm page module can render before its data arrives.
    if (!routeDataConsumed || !gateway.connected || !gateway.client) {
      return;
    }
    // A settings page can mount before connection; admit its reads through
    // both route changes and connected snapshots, including Advanced.
    if (
      surface === "settings" ||
      (activeRoutePluginId() && state.installedDetailTab === "configuration")
    ) {
      void context.runtimeConfig.ensureLoaded();
      void context.runtimeConfig.ensureSchemaLoaded();
    }
    if (!loading() && !state.result && !state.error) {
      void refreshCatalog();
    }
  }

  async function refreshCatalog(client = gateway.connected ? gateway.client : null) {
    if (!client || readAccess === false) {
      return;
    }
    setState({ error: null });
    await catalogTask.run([client]);
  }

  async function refreshDiscovery(): Promise<void> {
    if (surface !== "discovery") {
      return;
    }
    const catalogId = activeRoutePluginId();
    return catalogId ? showCatalogDetail(catalogId) : discovery.refresh();
  }

  function selectHubTab(tab: PluginsHubTab) {
    if (tab !== "plugins" || surface !== "discovery") {
      context.navigate(tab);
    }
  }

  function accessBlockedReason(
    mutationAllowed?: boolean,
    connected = gateway.connected,
  ): string | null {
    return pluginMutationBlockedReason({
      connected,
      hasAdminAccess: hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null),
      mutationAllowed,
    });
  }

  function canMutate(): boolean {
    return state.result?.mutationAllowed === true && accessBlockedReason() === null;
  }

  function canEditConfig(): boolean {
    const runtimeConfig = context.runtimeConfig;
    return accessBlockedReason(runtimeConfig.canSet, runtimeConfig.state.connected) === null;
  }

  function setBusy(key: string, value: PluginMutationAction | null) {
    const uninstallChanged = value === "uninstall" || state.busy[key] === "uninstall";
    const next = { ...state.busy };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    setState({ busy: next });
    if (uninstallChanged && state.detail && key === pluginRowKey(state.detail.pluginId)) {
      // Retire reads admitted before removal. A failed uninstall refreshes the
      // surviving plugin; success clears its detail before refreshing inventory.
      if (value === "uninstall") {
        setState({
          catalogDetail: state.catalogDetail ? { ...state.catalogDetail } : null,
        });
        void showDetails(state.detail.pluginId);
      } else {
        void refreshCatalog();
      }
    }
  }

  function setMessage(key: string, message: PluginRowMessage | null) {
    const next = { ...state.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    setState({ messages: next });
  }

  function applyMutationResult(result: PluginMutationResult) {
    icons.installed.invalidate(result.plugin.id);
    replaceResult(mergePluginCatalogItem(state.result, result.plugin));
  }

  function showDetails(pluginId: string | null) {
    mcpLogin.select(pluginId);
    return loadInstalledPluginDetail({
      pluginId,
      plugin: state.result?.plugins.find((entry) => entry.id === pluginId),
      catalog: state.catalogDetail?.result,
      gateway,
      canInspect: !pluginId || state.busy[pluginRowKey(pluginId)] !== "uninstall",
      getDetail: () => state.detail,
      onChange: (detail) => setState({ detail }),
    });
  }

  async function showCatalogDetail(id: string | null) {
    if (surface !== "discovery") {
      setState({ catalogDetail: null });
      return;
    }
    return loadPluginCatalogDetail({
      id,
      gateway,
      context,
      location: routeData?.location,
      inventory: state.result,
      uninstalling: uninstallingSelection(),
      getDetail: () => state.catalogDetail,
      onChange: (detail) => setState({ catalogDetail: detail }),
      showInstalled: showDetails,
    });
  }

  async function installCatalogEntry(id: string): Promise<void> {
    const scope = gateway.capture();
    const key = `install:${id}`;
    if (!scope || !canMutate() || state.busy[key]) {
      return;
    }
    const generation = ++installRequestGeneration;
    setBusy(key, "install");
    try {
      const result =
        state.catalogDetail?.result?.plugin.id === id
          ? state.catalogDetail.result
          : await loadPluginDiscoveryDetail(scope.client, id);
      if (!gateway.isCurrent(scope) || generation !== installRequestGeneration) {
        return;
      }
      const request = installRequestForDiscoveryDetail(result);
      setBusy(key, null);
      if (request) {
        await consent.install(request, key);
      } else {
        setMessage(key, {
          kind: "warning",
          text: t("pluginsPage.installAvailabilityChanged"),
        });
      }
    } catch (error) {
      if (gateway.isCurrent(scope) && generation === installRequestGeneration) {
        setMessage(key, { kind: "error", text: formatUiError(error) });
      }
    } finally {
      if (gateway.isCurrent(scope)) {
        setBusy(key, null);
      }
    }
  }

  function closeCatalogDetail() {
    setState({ catalogDetail: null, detail: null });
    context.navigate("plugins", {
      pathname: pathForRoute("plugins", context.basePath),
    });
  }

  async function uninstall(pluginId: string, rowKey: string): Promise<void> {
    const name = state.result?.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
    const trigger = options.element().contains(document.activeElement)
      ? document.activeElement
      : null;
    await consent.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, isLatest) => {
        if (state.detail?.pluginId === pluginId) {
          setState({ detail: null });
        }
        // Removal hides its row; any remaining warning belongs to the page.
        if (isLatest()) {
          setState({ pageNotice: pluginMutationWarnings(result, refreshError) });
          const routePluginId = activeRoutePluginId();
          if (routePluginId === pluginId) {
            context.replace("plugin-settings", {
              pathname: pathForRoute("plugin-settings", context.basePath),
            });
          }
        }
        await refreshCatalog(client);
        if (isLatest()) {
          onSettled(() => focusHeadingAfterRemoval(options.element(), trigger));
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
  return {
    read,
    get state() {
      return read();
    },
    context,
    gateway,
    icons,
    help,
    skillPreview,
    mcpLogin,
    discovery,
    settings,
    consent,
    settingsTab,
    setSettingsTab,
    get routeData() {
      revision();
      return routeData;
    },
    get surface() {
      revision();
      return surface;
    },
    get loading() {
      revision();
      return loading();
    },
    setState,
    refreshCatalog,
    selectHubTab,
    accessBlockedReason,
    canMutate,
    canEditConfig,
    showDetails,
    showCatalogDetail,
    installCatalogEntry,
    closeCatalogDetail,
    uninstall,
    reloadConfig(this: void) {
      pluginConfigEditPending = false;
      void context.runtimeConfig
        .discardDraft({ reloadOnly: true })
        .then(() => context.runtimeConfig.ensureSchemaLoaded());
    },
  };
}

export type PluginsPageModel = ReturnType<typeof createPluginsPage>;
