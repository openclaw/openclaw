import { isSettingsNavigationRoute, isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { APP_ROUTE_IDS } from "../app-routes.ts";
import type { GatewayStatusProps } from "../components/gateway-status.ts";
import type { SettingsSidebarFallbackProps } from "../components/settings-sidebar-lazy.tsx";
import { resolveGatewayStatus } from "../lib/gateway-status.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { isClawsAvailable } from "../pages/claws/availability.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "../pages/plugin/route.tsx";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { OutboxStoreRuntime } from "./app-shell-gateway.ts";
import type { ShellLazyOverlayHost } from "./app-shell-lazy-view.tsx";
import type { ShellViewCallbacks } from "./app-shell-view-callbacks.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import { canGoBackInNativeEmbed } from "./browser.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import { isMobileNavLayout, shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import type { NativeHistoryState } from "./native-web-chrome.ts";
import { isNativeEmbedHost, nativeEmbedHost, isNativeWebChromeHost } from "./native-web-chrome.ts";
import {
  floatingSidebarAttentionVisible,
  navigationSurfaceIsHidden,
  NAVIGATION_RAIL_WIDTH,
  type ShellNavigationElements,
} from "./navigation-surface.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import {
  isCustodianPanelAvailable,
  isDesktopPanelAvailable,
  isHomePanelAvailable,
} from "./panel-availability.ts";
import { resolveProfileAppearancePrefs } from "./server-prefs-profile.ts";
import { NAV_WIDTH_MAX, normalizeCatalogOpenTarget } from "./settings.ts";
import type { ShellLayoutOwner } from "./shell-layout-owner.ts";

export interface ShellViewHost extends ShellLazyOverlayHost, ShellNavigationElements {
  mobileGatewayStatus: GatewayStatusProps | null;
  readonly connectionRecovery: boolean;
  routeOutlet?: ControlUiReadinessOutlet;
  terminalPanel?: HTMLElement & { readonly available?: boolean };
  readonly shellRevision: () => number;
  readonly runtime: ApplicationRuntime | undefined;
  readonly activeSessionKey: string;
  readonly custodianMinimizeRequestId: number;
  readonly desktopNavigationExpanded: boolean;
  readonly nativeHistoryState: () => NativeHistoryState;
  readonly navDrawerOpen: boolean;
  readonly shellLayout: ShellLayoutOwner;
  readonly navigationSidebar: HTMLElement;
  readonly onboardingMode: boolean;
  readonly routeState: ShellRouteState;
  readonly settingsSearchQuery: string;
  readonly storedOutboxes: ReturnType<OutboxStoreRuntime["read"]> | undefined;
  readonly viewCallbacks: ShellViewCallbacks;
  readonly workspaceChromeVisible: boolean;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  readonly handleNativeNewSession: () => void;
  handleSettingsSearchQueryChange(query: string): Promise<void>;
  nativeNavCollapsed(): boolean;
  readonly openPalette: () => void;
  refreshControlUi: () => Promise<boolean>;
  invalidate(): void;
  resizeNavigation(splitRatio: number): void;
  readonly toggleNavigationSurface: (trigger?: HTMLElement) => void;
}

export function readShellView(host: ShellViewHost) {
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
  // Chat owns the live panes beneath its retained route island.
  const historyRecovering = (host.routeOutlet?.renderedElements?.("openclaw-chat-pane") ?? []).some(
    (pane) => pane.conversationPresented && pane.historyRecovering,
  );
  const connectionStatus = resolveGatewayStatus(
    gatewaySnapshot,
    controlUiRefreshRequired,
    historyRecovering,
  );
  const presentationScope = gatewayPresentationScope(context.gateway);
  // Initial hello can paint the shell before recovery finishes. Keep that brief
  // startup state in existing chrome rather than flashing recovery feedback.
  const initialConnection =
    !presentationScope.readyOnce &&
    !gatewaySnapshot.offlineStable &&
    (connectionStatus === "connecting" ||
      connectionStatus === "starting" ||
      connectionStatus === "restoring");
  const terminalAvailable = isTerminalAvailable(gatewaySnapshot, config.terminalEnabled ?? false);
  const desktopPanelAvailable = isDesktopPanelAvailable(gatewaySnapshot);
  const homePanelAvailable = isHomePanelAvailable(context.gateway);
  const custodianPanelAvailable = isCustodianPanelAvailable(context.gateway);
  const activeRoute = host.routeState.routeId ?? "chat";
  const sessionRoute = isSessionRouteId(activeRoute);
  const reloadRequired = gatewaySnapshot.phase === "reload-required";
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
  const requestedRouteAgentId = host.shellNavigation.newSessionRouteAgentId();
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
  const workspacePluginsEnabled = activeRoute !== "plugins" && activeRoute !== "plugin-settings";
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
    enabledRouteIds:
      isClawsAvailable(context.runtimeConfig.state) === true
        ? APP_ROUTE_IDS
        : APP_ROUTE_IDS.filter((routeId) => routeId !== "claws"),
    sessionKey: host.activeSessionKey,
    connected: gatewayConnected,
    connectionStatus,
    footerControlsOverlap: host.shellLayout.footerControlsOverlap,
    storedOutboxes: host.storedOutboxes,
    terminalAvailable,
    catalogOpenTarget: normalizeCatalogOpenTarget(uiSettings.catalogOpenTarget),
    canPairDevice: gatewayConnected && operatorAccess.canAdmin,
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
    onNavigate: host.shellNavigation.navigate,
  };
  const embedNavigation =
    nativeEmbed && !(nativeEmbedHost()?.surface === "conversation" && activeRoute === "chat");
  const collapsedControls =
    !nativeEmbed && navCollapsed && !onboarding && !settingsTakeover && !mobileNavLayout;
  const shellConnectionStatus = !nativeEmbed && !initialConnection ? connectionStatus : null;
  const gatewayStatus: GatewayStatusProps = {
    kind: shellConnectionStatus ?? (!nativeEmbed && gatewayConnected ? "connected" : null),
    lastError: shellConnectionStatus ? gatewaySnapshot.lastError : null,
    queuedCount: shellConnectionStatus
      ? (host.storedOutboxes?.total ?? 0) + (gatewaySnapshot.deferredIntentCount ?? 0)
      : 0,
    onRetry: callbacks.retryGateway,
  };
  const mobileGatewayStatus =
    mobileNavLayout && !navDrawerOpen && !nativeEmbed ? gatewayStatus : null;
  const floatingUpdateCard = {
    navigationSurfaceHidden,
    mobileNavLayout,
    onboarding,
    compact: mergedChatChrome && !controlUiRefreshRequired,
    statusBanner: overlaySnapshot.updateStatusBanner,
    updateRun: overlaySnapshot.updateRun,
    refreshRequired: controlUiRefreshRequired,
    onRefresh: host.refreshControlUi,
    onNavigate: host.shellNavigation.navigate,
  };
  const settingsSidebarProps: SettingsSidebarFallbackProps = {
    presentation: nativeEmbed ? (embedSettingsRoot ? "embed-list" : "embed-page") : "sidebar",
    activeRouteId: activeRoute,
    connectionStatus,
    onExit: () => {
      if (!nativeEmbed) {
        host.shellNavigation.exitSettings();
      } else if (canGoBackInNativeEmbed()) {
        window.history.back();
      } else if (activeRoute === "memory-import") {
        context.replace("memory");
      } else {
        host.shellNavigation.navigate("settings");
      }
    },
    canAdmin: operatorAccess.canAdmin,
    nativeDeviceSettings: context.nativeDeviceSettings,
  };
  return {
    nowMs: Date.now(),
    routeReady: host.routeState.routeId !== undefined || host.routeState.routeFailed,
    workspaceChromeVisible: host.workspaceChromeVisible,
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
    workbenchRoute:
      !host.routeState.routeFailed &&
      !host.routeState.sessionRouteNotice &&
      isSessionRouteId(host.routeState.routeId),
    reloadRequired,
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
    workspacePluginsEnabled,
    uiSettings,
    backgroundReady,
    chatLikeRoute,
    sidebarProperties,
    embedNavigation,
    collapsedControls,
    shellConnectionStatus,
    gatewayStatus,
    mobileGatewayStatus,
    connectionRecovery: host.connectionRecovery,
    floatingUpdateCard,
    settingsSidebarProps,
  };
}
