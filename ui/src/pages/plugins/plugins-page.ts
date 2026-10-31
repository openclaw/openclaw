import { createEffect, createSignal, onSettled } from "solid-js";
import type { PluginsUninstallResult } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import {
  pathForRoute,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { hasModalSurface, registryFor } from "../../components/overlay-registry.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { isComposingKeyboardEvent } from "../../lib/ime.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import {
  loadPluginDiscoveryDetail,
  type PluginListResult,
  type PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createCredentialPresentation } from "./credential-presentation.ts";
import { installedPluginDetailTabFromHash } from "./detail-tabs.ts";
import { createPluginDiscovery } from "./plugin-discovery.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createPluginMcpLogin } from "./plugin-mcp-login.ts";
import { createPluginPageTargets } from "./plugin-removal-focus.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import { pluginMutationWarnings, createPluginsConsent } from "./plugins-consent.ts";
import { createPluginDetailReads } from "./plugins-detail-reads.ts";
import { createPluginsMutationPresentation } from "./plugins-mutation-presentation.ts";
import { createPluginsPageIcons } from "./plugins-page-icons.ts";
import {
  createPluginsPageState,
  installRequestForDiscoveryDetail,
  mergePluginCatalogItem,
  pluginMutationBlockedReason,
  type PluginMutationAction,
} from "./plugins-page-model.ts";
import type { PluginsRouteData } from "./route-data.ts";
import type { PluginSettingsEditorProps } from "./settings-editor.tsx";
import type { PluginSettingsTab } from "./settings-view.tsx";
import { createPluginPreview } from "./skill-preview.tsx";

export function createPluginsPage(options: {
  context: ApplicationContext;
  element: () => HTMLElement;
  routeData: () => PluginsRouteData | undefined;
  surface: () => "discovery" | "settings";
}) {
  const context = options.context;
  const runtime = context.runtimeConfig;
  let active = true;
  const targets = createPluginPageTargets();
  let routeData: PluginsRouteData | undefined;
  let surface: "discovery" | "settings" = "settings";
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [settingsTab, setSettingsTab] = createSignal<PluginSettingsTab>("installed");

  const state = createPluginsPageState();
  const credentialPresentation = createCredentialPresentation(context.router);
  const details = createPluginDetailReads({
    state,
    setState,
    context,
    gateway: () => gateway,
    surface: () => surface,
    routeData: () => routeData,
    uninstalling: uninstallingSelection,
    selectInstalled: (pluginId) => mcpLogin.select(pluginId),
  });
  const { showDetails, showCatalogDetail } = details;

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
    if (patch.detail === null) {
      details.inspection.reset();
    }
    if (patch.catalogDetail === null) {
      details.catalog.reset();
    }
    Object.assign(state, patch);
    publish();
  }

  let installRequestGeneration = 0;
  const help = createPluginHelp(context);
  let pluginConfigEditPending = false;
  let routeDataConsumed = false;
  const [catalog, setCatalog] = createSignal<Promise<void> | null>(null, { ownedWrite: true });
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
    refresh: showDetails,
    setMessage,
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

  const resolveCredential: PluginSettingsEditorProps["resolveCredential"] = (field) => {
    const detail = state.detail;
    const descriptor = detail?.inspection?.credentials?.find(
      (entry) =>
        entry.path.length === field.path.length &&
        entry.path.every((segment, index) => segment === field.path[index]),
    );
    if (!detail || !descriptor) {
      return undefined;
    }
    return {
      field,
      descriptor,
      context: {
        pluginId: detail.pluginId,
        baseHash: runtime.state.configSnapshot?.hash ?? null,
        gateway,
        canInspect: hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null),
        getPresentationLifetime: () => credentialPresentation.lifetime,
        // Awaited writes and discards can settle before the presentation catches up.
        get saveError() {
          return runtime.state.lastError;
        },
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

  const canMutate = () => state.result?.mutationAllowed === true && accessBlockedReason() === null;

  const mutationPresentation = createPluginsMutationPresentation({
    gateway,
    read,
    isActive: () => active,
    lifetime: () => credentialPresentation.lifetime,
    catalog,
    setMessage,
  });

  const consent = createPluginsConsent({
    gateway,
    getContext: () => context,
    getResult: () => state.result,
    canMutate,
    isBusy: (rowKey) => Boolean(state.busy[rowKey]),
    setBusy,
    setMessage,
    getMessages: () => state.messages,
    clearPageNotice: () => setState({ pageNotice: null }),
    closeDetails: skillPreview.close,
    applyMutationResult,
    refreshCatalogAfterMutation: refreshCatalog,
    presentMutation: mutationPresentation.present,
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
  onSettled(() => {
    let configAutoSaveStatus = runtime.state.configAutoSaveStatus;
    // Preserve saving-to-saved receipts so plugin edits refresh the catalog even within one render turn.
    return runtime.subscribe(() => {
      const nextStatus = runtime.state.configAutoSaveStatus;
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
        credentialPresentation.retire();
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
      catalogTask.cancel();
      details.inspection.release();
      details.catalog.release();
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
      hasModalSurface(document) ||
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
    const progress = targets.openInstallAction();
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
    if (skillPreview.state) {
      return;
    }
    // Firefox does not emit blur when a focused input is removed from the document.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && options.element().contains(focused)) {
      focused.blur();
    }
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
    credentialPresentation.retire();
    details.inspection.reset();
    details.catalog.reset();
    mcpLogin.reset();
    if (invalidateCatalog) {
      void setCatalog(null);
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

  const loading = () => gateway.connected && (!routeDataConsumed || catalogTask.pending);

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
    const promise = catalogTask.run([client]);
    void setCatalog(promise);
    await promise;
  }

  async function refreshDiscovery(): Promise<void> {
    if (surface !== "discovery") {
      return;
    }
    const catalogId = activeRoutePluginId();
    return catalogId ? showCatalogDetail(catalogId) : discovery.refresh();
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

  function canEditConfig(): boolean {
    return accessBlockedReason(runtime.canSet, runtime.state.connected) === null;
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
      (client) => client.request<PluginsUninstallResult>("plugins.uninstall", { pluginId }),
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
        const detailRead = surface === "discovery" && details.catalog.receipt();
        if (detailRead) {
          // The inventory refresh starts a separate catalog read. Its heading must exist first.
          await detailRead.result.catch(() => {});
        }
        if (isLatest() && (!detailRead || details.catalog.receipt() === detailRead)) {
          onSettled(() => targets.focusAfterRemoval(trigger));
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
    presentedEnabled: mutationPresentation.enabled,
    mutationSaving: mutationPresentation.saving,
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
    settings: { patch, resolveCredential },
    consent,
    ...targets,
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
    routeLoading: () => gateway.connected && !routeDataConsumed,
    catalogRead: catalog,
    inspectionRead: details.inspection,
    detailRead: details.catalog,
    setState,
    refreshCatalog,
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
