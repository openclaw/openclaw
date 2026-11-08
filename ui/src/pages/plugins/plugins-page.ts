import { createEffect, createSignal, onSettled } from "solid-js";
import type { PluginsUninstallResult } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { hasModalSurface, registryFor } from "../../components/overlay-registry.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { isComposingKeyboardEvent } from "../../lib/ime.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import type { PluginListResult, PluginMutationResult } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createCredentialPresentation } from "./credential-presentation.ts";
import { installedPluginDetailTabFromHash } from "./detail-tabs.ts";
import { createPluginDiscovery } from "./plugin-discovery.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createPluginMcpLogin } from "./plugin-mcp-login.ts";
import { createPluginPromptLaunch } from "./plugin-prompt-launch.ts";
import { createPluginPageTargets } from "./plugin-removal-focus.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import { pluginMutationWarnings, createPluginsConsent } from "./plugins-consent.ts";
import { createPluginDetailReads } from "./plugins-detail-reads.ts";
import { createPluginsMutationPresentation } from "./plugins-mutation-presentation.ts";
import { createPluginsPageIcons } from "./plugins-page-icons.ts";
import {
  createPluginsPageState,
  mergePluginCatalogItem,
  pluginMutationBlockedReason,
  type PluginMutationAction,
} from "./plugins-page-model.ts";
import {
  pluginIdForRoute,
  pluginSettingsNeedsSchema,
  type PluginsCatalogRead,
  type PluginsRouteData,
} from "./route-data.ts";
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
  const [renderedIconRevision, setRenderedIconRevision] = createSignal(0);
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

  const promptLaunch = createPluginPromptLaunch({
    context,
    state,
    gateway: () => gateway,
    consent: () => consent,
    isActive: () => active,
    pathname: () => routeData?.location.pathname,
    accessBlockedReason,
    setMessage,
    publish,
  });
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
    onRenderedChange: () => setRenderedIconRevision((current) => current + 1),
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

  onSettled(() => context.overlays.subscribe(publish));

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
    getCatalogDetail: () => state.catalogDetail?.result ?? null,
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
    onMutationSuccess: promptLaunch.complete,
    onConsentDismiss: promptLaunch.reset,
  });
  const catalogTask = createPageRequest(publish, {
    task: async (
      [client, prepared]: readonly [
        NonNullable<GatewayPageBinding["client"]>,
        PluginsCatalogRead["result"]?,
      ],
      { signal },
    ) => {
      if (!prepared) {
        return client.request<PluginListResult>("plugins.list", {}, { signal });
      }
      const result = await prepared;
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },
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
          consent.invalidateCatalogInstall();
          promptLaunch.reset();
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
      renderedIconRevision();
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
      promptLaunch.reset();
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
    // Settings details bubble to the shell's shared, location-aware parent navigation.
    if (state.detail && surface === "discovery") {
      setState({ detail: null });
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
    // Navigation stays usable before Gateway reads settle, including deep links.
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
    if (surface === "settings" && detailPluginId !== state.detail?.pluginId) {
      void showDetails(detailPluginId);
    }
    if (catalogId !== state.catalogDetail?.id) {
      void showCatalogDetail(catalogId);
    }
    const prepared = data.catalogRead;
    ensureInitialData(
      prepared && gateway.isRouteDataCurrent(prepared) ? prepared.result : undefined,
    );
  }

  function invalidateRequests(invalidateCatalog: boolean, retirePresentation = true) {
    promptLaunch.reset();
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
    // Detail selection needs the installed identity before choosing its local reader.
    if (result && surface === "discovery" && activeRoutePluginId()) {
      void refreshDiscovery();
    }
  }

  const loading = () => gateway.connected && (!routeDataConsumed || catalogTask.pending);

  const activeRoutePluginId = () =>
    pluginIdForRoute(surface, routeData?.location.pathname ?? "", context.basePath);

  function uninstallingSelection(): boolean {
    return Boolean(
      state.detail &&
      state.busy[pluginRowKey(state.detail.pluginId)] === "uninstall" &&
      activeRoutePluginId() ===
        (surface === "settings" ? state.detail.pluginId : state.catalogDetail?.id),
    );
  }

  function ensureInitialData(prepared?: PluginsCatalogRead["result"]) {
    if (readAccess === false) {
      return;
    }
    // Category navigation needs neither installed inventory nor catalog cards.
    // Start it as soon as this discovery page has a connection, even while the
    // installed inventory request is pending.
    if (surface === "discovery" && !activeRoutePluginId()) {
      void discovery.ensureCategories();
    }
    // The route admits location and scope before the page starts its reads.
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
    }
    if (routeData && pluginSettingsNeedsSchema(surface, routeData.location, context.basePath)) {
      void context.runtimeConfig.ensureSchemaLoaded();
    }
    if (!loading() && (prepared || (!state.result && !state.error))) {
      void refreshCatalog(gateway.client, prepared);
    }
  }

  async function refreshCatalog(
    client = gateway.connected ? gateway.client : null,
    prepared?: PluginsCatalogRead["result"],
  ) {
    if (!client || readAccess === false) {
      return;
    }
    setState({ error: null });
    // Browsing carries its own local facts; inventory authority only gates mutations.
    if (surface === "discovery" && !activeRoutePluginId()) {
      void discovery.refresh();
    }
    const promise = catalogTask.run([client, prepared]);
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
      actorKind:
        context.gateway.snapshot.hello?.auth.roleAllowsAdmin === false ? "member" : "browser",
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
    promptLaunch.onMessage(key, message);
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
    if (surface === "discovery" && !activeRoutePluginId()) {
      void discovery.refresh();
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
    installCatalogEntry: consent.installCatalogEntry,
    recommendedPrompts: promptLaunch,
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
