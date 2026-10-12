import { untrack } from "solid-js";
import { isSettingsNavigationRoute, isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { APP_ROUTE_IDS } from "../app-routes.ts";
import { renderLazySettingsSidebar } from "../components/settings-sidebar-lazy.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { resolveGatewayStatus } from "../lib/gateway-status.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { ChatPaneBase } from "../pages/chat/chat-pane-base.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { DevicePairSetupLoader } from "./app-shell-device-pair-setup.tsx";
import type { OutboxStoreRuntime } from "./app-shell-gateway.ts";
import type { ShellLazyOverlayHost } from "./app-shell-lazy-view.tsx";
import type { ShellViewCallbacks } from "./app-shell-view-callbacks.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import { canGoBackInNativeEmbed } from "./browser.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import {
  APP_SIDEBAR_ELEMENT,
  isOptionalElementDefined,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { isMobileNavLayout, shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import type { NativeHistoryState } from "./native-web-chrome.ts";
import { isNativeEmbedHost, nativeEmbedHost, isNativeWebChromeHost } from "./native-web-chrome.ts";
import {
  floatingSidebarAttentionVisible,
  navigationSurfaceIsHidden,
  NAVIGATION_RAIL_WIDTH,
} from "./navigation-surface.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import { isDesktopPanelAvailable, isHomePanelAvailable } from "./panel-availability.ts";
import { resolveProfileAppearancePrefs } from "./server-prefs-profile.ts";
import { NAV_WIDTH_MAX, normalizeCatalogOpenTarget } from "./settings.ts";
import type { ShellLayoutOwner } from "./shell-layout-owner.ts";

export interface ShellViewHost extends ShellLazyOverlayHost {
  readonly devicePairSetup: DevicePairSetupLoader;
  readonly shellRevision: () => number;
  readonly settingsSidebar: Parameters<typeof renderLazySettingsSidebar>[0];
  readonly runtime: ApplicationRuntime | undefined;
  readonly activeSessionKey: string;
  readonly custodianMinimizeRequestId: number;
  readonly desktopNavigationExpanded: boolean;
  readonly execApprovalElement: OptionalCustomElement;
  readonly onboardingMemoryImportElement: OptionalCustomElement;
  readonly nativeHistoryState: NativeHistoryState;
  readonly navDrawerOpen: boolean;
  navResizing: boolean;
  readonly shellLayout: ShellLayoutOwner;
  readonly navigationSidebar: HTMLElement;
  readonly onboardingMode: boolean;
  readonly routeState: ShellRouteState;
  readonly settingsPreloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  readonly settingsSearchQuery: string;
  readonly storedOutboxes: ReturnType<OutboxStoreRuntime["read"]> | undefined;
  readonly viewCallbacks: ShellViewCallbacks;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  newSessionRouteAgentId(): string;
  exitSettings(): void;
  readonly handleNativeNewSession: () => void;
  handleSettingsSearchQueryChange(query: string): Promise<void>;
  handleThemeChange(event: CustomEvent<ThemeModeChangeDetail>): void;
  nativeNavCollapsed(): boolean;
  readonly openPalette: () => void;
  readonly navigate: (routeId: string, options?: ApplicationNavigationOptions) => void;
  refreshControlUi: () => Promise<boolean>;
  recoverNotFoundRoute: () => boolean;
  prepareView(): void;
  invalidate(): void;
  querySelectorAll: ParentNode["querySelectorAll"];
  resizeNavigation(splitRatio: number): void;
  readonly toggleNavigationSurface: (trigger?: HTMLElement) => void;
}

export function readShellView(host: ShellViewHost) {
  untrack(() => host.prepareView());
  const context = host.context;
  const runtime = host.runtime;
  const callbacks = host.viewCallbacks;
  if (!context || !runtime) {
    throw new Error("The application shell requires an active runtime");
  }
  const gatewaySnapshot = context.gateway.snapshot;
  const config = context.config.current;
  const gatewayConnected = gatewaySnapshot.phase === "connected";
  const operatorAccess = readGatewayOperatorAccess(gatewaySnapshot);
  const navigationSnapshot = context.navigation.snapshot;
  const overlaySnapshot = context.overlays.snapshot;
  const controlUiRefreshRequired = overlaySnapshot.controlUiRefreshRequired;
  const historyRecovering = [...host.querySelectorAll<ChatPaneBase>("openclaw-chat-pane")].some(
    (pane) => pane.conversationPresented && pane.historyRecovering,
  );
  const connectionStatus = resolveGatewayStatus(
    gatewaySnapshot,
    controlUiRefreshRequired,
    historyRecovering,
  );
  const presentationScope = gatewayPresentationScope(context.gateway);
  // Initial hello can paint the shell before recovery finishes. Keep that brief
  // startup state in existing chrome rather than inserting and removing a row.
  const initialConnection =
    !presentationScope.readyOnce &&
    !gatewaySnapshot.offlineStable &&
    (connectionStatus === "connecting" ||
      connectionStatus === "starting" ||
      connectionStatus === "restoring");
  // The install keeps running after `update.run` answers, so the reconciliation
  // — not the request — decides how long the update surfaces stay busy.
  const updateBusy = overlaySnapshot.updateRunning || overlaySnapshot.updateReconciliationPending;
  const terminalAvailable = isTerminalAvailable(gatewaySnapshot, config.terminalEnabled ?? false);
  const desktopPanelAvailable = isDesktopPanelAvailable(gatewaySnapshot);
  const homePanelAvailable = isHomePanelAvailable(context.gateway);
  const custodianPanelAvailable =
    // Scope-aware to match the store: admin-only, never advertisement alone.
    canCallGatewayMethod(gatewaySnapshot, "openclaw.chat", "operator.admin");
  const activeRoute = host.routeState.routeId ?? "chat";
  const sessionRoute = isSessionRouteId(activeRoute);
  // Session routes have an offline outbox, New Session keeps a local draft, and
  // Appearance persists local preference intent for replay. Connection settings
  // must remain usable to replace an unreachable Gateway. Their server actions
  // are independently gated; other pages cannot submit useful disconnected work.
  const reloadRequired = gatewaySnapshot.phase === "reload-required";
  const pageActionsBlocked =
    !reloadRequired &&
    !gatewayConnected &&
    !sessionRoute &&
    activeRoute !== "new-session" &&
    activeRoute !== "appearance" &&
    activeRoute !== "connection";
  // Plugin tabs share one route; the URL picks the active item.
  const activePluginRef =
    activeRoute === "plugin"
      ? pluginTabRefFromSearch(
          host.routeState.location?.search ?? "",
          host.routeState.location?.pathname,
          context.basePath,
        )
      : null;
  // Onboarding renders without any navigation chrome, so the settings takeover
  // must not reserve its fixed sidebar column (the grid would stay off-center).
  const nativeEmbed = isNativeEmbedHost();
  const embedSettingsRoot = nativeEmbed && activeRoute === "settings";
  const embedSettings =
    nativeEmbed &&
    (activeRoute === "settings" ||
      isSettingsNavigationRoute(activeRoute) ||
      activeRoute === "skills" ||
      activeRoute === "cron");
  const settingsTakeover = isSettingsTakeover(activeRoute) && !host.onboardingMode && !nativeEmbed;
  const runtimeConfig = context.runtimeConfig.state;
  const onboarding = host.onboardingMode;
  const memoryImportActive = onboarding && activeRoute !== "custodian";
  const navDrawerOpen = host.navDrawerOpen && !onboarding && !nativeEmbed;
  const mobileNavLayout = isMobileNavLayout();
  const nativeWebChrome = isNativeWebChromeHost() && !nativeEmbed;
  const mergedChatChrome = shouldMergeChatChrome({
    mobileNavLayout,
    routeId: activeRoute,
    onboarding,
  });
  // Drawer navigation always opens expanded; the tab's desktop collapse state
  // stays in memory for when the viewport returns to the desktop layout.
  // The settings sidebar has a fixed width, so the collapse state pauses too.
  const navCollapsed =
    !nativeEmbed &&
    navigationSnapshot.navCollapsed &&
    !host.desktopNavigationExpanded &&
    !navDrawerOpen &&
    !settingsTakeover;
  const railAvailable = !nativeEmbed && !settingsTakeover && !onboarding;
  const railWidth = railAvailable ? NAVIGATION_RAIL_WIDTH : 0;
  const expandedNavWidth = navigationSnapshot.navWidth + railWidth;
  const navigationSurfaceHidden = navigationSurfaceIsHidden({
    onboarding,
    navCollapsed,
    navDrawerOpen,
    mobileNavLayout,
    railAvailable,
  });
  const floatingAttentionVisible =
    !nativeEmbed &&
    floatingSidebarAttentionVisible({
      navigationSurfaceHidden,
      mobileNavLayout,
      onboarding,
      compact: mergedChatChrome,
    });
  const shellWidth = Math.max(globalThis.innerWidth || 0, NAV_WIDTH_MAX);
  // A route query is navigation input, not an owner record. Let it override the
  // live selection only after the roster proves that agent exists.
  const requestedRouteAgentId = host.newSessionRouteAgentId();
  const routeAgentId = requestedRouteAgentId ? normalizeAgentId(requestedRouteAgentId) : null;
  const routeAgentIsKnown =
    routeAgentId !== null &&
    context.agents.state.agentsList?.agents.some(
      (agent) => normalizeAgentId(agent.id) === routeAgentId,
    ) === true;
  const selectedAgentId = routeAgentIsKnown
    ? routeAgentId
    : normalizeAgentId(context.agentSelection.state.selectedId ?? gatewaySnapshot.assistantAgentId);
  const newSessionAccess = readSessionMethodAccess(gatewaySnapshot, {
    method: "sessions.create",
    params: {},
    sessionScope: true,
  });
  const newSessionDisabledReason = newSessionAccess.allowed ? undefined : newSessionAccess.reason;
  const workspaceReplacement =
    activeRoute === "plugins" || activeRoute === "plugin-settings"
      ? undefined
      : context.plugins.selectedReplacement("workspace");
  const uiSettings = context.theme.settings;
  // Unknown profile preferences are not absence. Keep the first shell paint
  // image-free so a saved None choice cannot download artwork before hydration.
  const profileId = gatewaySnapshot.selfUser?.id;
  const backgroundReady =
    gatewayConnected &&
    (!profileId ||
      resolveProfileAppearancePrefs(context.gateway.connection.gatewayUrl, profileId) !== null);
  // The new-session draft shares the chat layout: full-height pane that owns
  // its scrolling and pins the composer dock to the bottom.
  const chatLikeRoute = sessionRoute || activeRoute === "new-session" || activeRoute === "systems";
  const sidebarProperties = {
    basePath: context.basePath,
    activeRouteId: activeRoute,
    router: runtime.router,
    activePluginTabId: activePluginRef ? pluginTabKey(activePluginRef) : "",
    enabledRouteIds: APP_ROUTE_IDS,
    sessionKey: host.activeSessionKey,
    connected: gatewayConnected,
    connectionStatus,
    lastError: gatewaySnapshot.lastError,
    storedOutboxes: host.storedOutboxes,
    terminalAvailable,
    catalogOpenTarget: normalizeCatalogOpenTarget(uiSettings.catalogOpenTarget),
    canPairDevice: gatewayConnected && (operatorAccess.canAdmin || operatorAccess.canPair),
    sidebarEntries: navigationSnapshot.sidebarEntries,
    navigationVisible: !navigationSurfaceHidden,
    navigationCollapsed: navCollapsed,
    sidebarAgentsMode: uiSettings.sidebarAgentsMode ?? "chip",
    sidebarLiveActivity: uiSettings.sidebarLiveActivity !== false,
    pinnedAgentIds: navigationSnapshot.pinnedAgentIds,
    themeMode: context.theme.mode,
    gatewayVersion: config.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? null,
    devGitBranch: config.devGitBranch,
    watchUpdateProgress: callbacks.watchUpdateProgress,
    onOpenPalette: host.openPalette,
    onRetryConnect: callbacks.retryGateway,
    onToggleSidebar: callbacks.toggleSidebar,
    onOpenNewSession: callbacks.requestOpenNewSession,
    onUpdateSidebarEntries: callbacks.updateSidebarEntries,
    onPairMobile: callbacks.openDevicePairSetup,
    onNavigate: host.navigate,
    onPreloadRoute: callbacks.preloadRoute,
  };
  const embedNavigation =
    nativeEmbed && !(nativeEmbedHost()?.surface === "conversation" && activeRoute === "chat");
  const collapsedControls =
    !nativeEmbed && navCollapsed && !onboarding && !settingsTakeover && !mobileNavLayout;
  const shellConnectionStatus =
    (navigationSurfaceHidden ||
      (settingsTakeover
        ? host.settingsSidebar.renderer === null
        : !isOptionalElementDefined(APP_SIDEBAR_ELEMENT))) &&
    !nativeEmbed &&
    !onboarding &&
    !initialConnection
      ? connectionStatus
      : null;
  const floatingUpdateCard = {
    navigationSurfaceHidden,
    mobileNavLayout,
    onboarding,
    compact: mergedChatChrome && !controlUiRefreshRequired,
    statusBanner: overlaySnapshot.updateStatusBanner,
    updateRun: overlaySnapshot.updateRun,
    refreshRequired: controlUiRefreshRequired,
    onRefresh: host.refreshControlUi,
    onNavigate: host.navigate,
  };
  const navigationContent =
    settingsTakeover || embedNavigation
      ? renderLazySettingsSidebar(host.settingsSidebar, {
          presentation: nativeEmbed ? (embedSettingsRoot ? "embed-list" : "embed-page") : "sidebar",
          basePath: context.basePath,
          activeRouteId: activeRoute,
          agents: context.agents.state.agentsList?.agents ?? [],
          agentIdentity: context.agentIdentity,
          settingsAgentSelection: context.settingsAgentSelection,
          activePathname: host.routeState.location?.pathname ?? "",
          activeSearch: host.routeState.location?.search ?? "",
          activeHash: host.routeState.location?.hash ?? "",
          connectionStatus,
          lastError: gatewaySnapshot.lastError,
          gatewayVersion: config.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? "",
          searchQuery: embedSettingsRoot ? "" : host.settingsSearchQuery,
          searchParams: {
            query: host.settingsSearchQuery,
            schema: runtimeConfig.configSchema,
            value: runtimeConfig.configForm ?? runtimeConfig.configSnapshot?.config ?? null,
            uiHints: runtimeConfig.configUiHints,
            identityAvailable: Boolean(gatewaySnapshot.selfUser),
            multipleProfiles:
              gatewaySnapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true,
            basePath: context.basePath,
            canAdmin: operatorAccess.canAdmin,
            nativeDeviceSettings: context.nativeDeviceSettings,
          },
          onExit: () => {
            if (!nativeEmbed) {
              host.exitSettings();
            } else if (canGoBackInNativeEmbed()) {
              window.history.back();
            } else if (activeRoute === "memory-import") {
              context.replace("memory");
            } else {
              host.navigate("settings");
            }
          },
          onRetryConnect: callbacks.retryGateway,
          onNavigate: host.navigate,
          onPreload: callbacks.preloadRoute,
          onSearchQueryChange: (nextQuery) => void host.handleSettingsSearchQueryChange(nextQuery),
          preloadTimers: host.settingsPreloadTimers,
          saveIndicator: {
            status: runtimeConfig.configRecoveryError
              ? "recovery"
              : runtimeConfig.configAutoSaveStatus,
            lastError: runtimeConfig.configRecoveryError ?? runtimeConfig.lastError,
            needsApply: runtimeConfig.configNeedsApply,
            applying: runtimeConfig.configApplying,
            applyDisabled:
              context.runtimeConfig.canApply === false ||
              runtimeConfig.configLoading ||
              runtimeConfig.configSaving ||
              (runtimeConfig.configFormDirty && runtimeConfig.configFormMode === "raw") ||
              updateBusy,
            onRetry: () => void context.runtimeConfig.retry(),
            onSave: () => void context.runtimeConfig.save(),
            onReload: () => void context.runtimeConfig.discardDraft(),
            onApply: () => void context.runtimeConfig.apply(),
          },
          canAdmin: operatorAccess.canAdmin,
          nativeDeviceSettings: context.nativeDeviceSettings,
        })
      : null;
  return {
    nowMs: Date.now(),
    context,
    runtime,
    callbacks,
    gatewaySnapshot,
    config,
    gatewayConnected,
    overlaySnapshot,
    connectionStatus,
    presentationScope,
    terminalAvailable,
    desktopPanelAvailable,
    homePanelAvailable,
    custodianPanelAvailable,
    activeRoute,
    sessionRoute,
    reloadRequired,
    pageActionsBlocked,
    nativeEmbed,
    embedSettings,
    settingsTakeover,
    onboarding,
    memoryImportActive,
    navDrawerOpen,
    mobileNavLayout,
    nativeWebChrome,
    mergedChatChrome,
    navCollapsed,
    railAvailable,
    railWidth,
    expandedNavWidth,
    navigationSurfaceHidden,
    floatingAttentionVisible,
    shellWidth,
    selectedAgentId,
    newSessionDisabledReason,
    workspaceReplacement,
    uiSettings,
    backgroundReady,
    chatLikeRoute,
    sidebarProperties,
    embedNavigation,
    collapsedControls,
    shellConnectionStatus,
    floatingUpdateCard,
    navigationContent,
    navigationSnapshot,
  };
}
