import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createRoot, getOwner, runWithOwner, untrack } from "solid-js";
import {
  formatDocumentTitle,
  isSettingsNavigationRoute,
  titleForRoute,
} from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import "../components/app-topbar.ts";
import "../components/assistant-panel.ts";
import type { RouteId } from "../app-routes.ts";
import "../components/resizable-divider.ts";
import type { AppSidebarBase } from "../components/app-sidebar-base.ts";
import type {
  CommandPaletteElement,
  CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import { askBrandLabel } from "../components/theme-brand-label.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import { i18n } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store-scope.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import {
  projectAgentSelection,
  projectApplicationConfig,
  projectGateway,
} from "../lib/reactive/application.ts";
import { projectAgents, projectRuntimeConfig } from "../lib/reactive/domain-capabilities.ts";
import { projectI18n, t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiKnownSelectedGlobalAgentId,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import type { ChatPage } from "../pages/chat/chat-page.ts";
import { retireSessionPaneHandoffs } from "../pages/chat/chat-pane-handoff-lifecycle.ts";
import { equalShellRouteState, selectShellRouteState } from "./app-host-route-state.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
import {
  ShellGatewayOwner,
  type OutboxStoreRuntime,
  type ShellGatewayHost,
  type StoredOutboxScopeHost,
} from "./app-shell-gateway.ts";
import { ShellNavigationOwner, type ShellNavigationHost } from "./app-shell-navigation.ts";
import { ShellPresentation } from "./app-shell-presentation.ts";
import "./app-shell-locale-recovery.ts";
import { createShellViewCallbacks } from "./app-shell-view-callbacks.ts";
import { renderApplicationShell, type ShellViewHost } from "./app-shell-view.tsx";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import type { ControlUiReadiness } from "./control-ui-readiness.ts";
import { createGatewayControlUiReloadOptions } from "./gateway-control-ui-reload.ts";
import {
  APP_SIDEBAR_ELEMENT,
  BROWSER_PANEL_ELEMENT,
  COMMAND_PALETTE_ELEMENT,
  DESKTOP_PANEL_ELEMENT,
  EXEC_APPROVAL_ELEMENT,
  LazyCustomElementRequestController,
  LINK_READER_PANEL_ELEMENT,
  type OptionalCustomElement,
  TERMINAL_PANEL_ELEMENT,
} from "./lazy-custom-element.ts";
import { LazyRenderer } from "./lazy-renderer.ts";
import { postNativeNavState, type NativeNavState } from "./native-nav-state.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { isApplyingServerUiPrefs, pushServerUiPrefs } from "./server-prefs.ts";
import { capturePlacementStartupConnection } from "./session-placement-startup.ts";
import { setSettingsChangeListener } from "./settings.ts";
import { ShellLayoutOwner } from "./shell-layout-owner.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

export class ShellOwner
  extends ShellPresentation
  implements ShellChromeHost, ShellGatewayHost, ShellNavigationHost, ShellViewHost
{
  runtime: ApplicationRuntime | undefined;
  readiness: ControlUiReadiness | undefined;
  onboarding = false;
  private readonly cleanups: Array<() => void> = [];
  readonly shellLayout = new ShellLayoutOwner(() => this.invalidate());
  readonly commandPaletteElement = COMMAND_PALETTE_ELEMENT;
  readonly terminalPanelElement = TERMINAL_PANEL_ELEMENT;
  readonly browserPanelElement = BROWSER_PANEL_ELEMENT;
  readonly linkReaderPanelElement = LINK_READER_PANEL_ELEMENT;
  readonly desktopPanelElement = DESKTOP_PANEL_ELEMENT;
  readonly execApprovalElement = EXEC_APPROVAL_ELEMENT;
  readonly onboardingMemoryImportElement = {
    tagName: "openclaw-onboarding-memory-import",
    label: t("onboarding.memoryImport.title"),
    loadModule: () => import("../components/onboarding-memory-import.ts"),
  } satisfies OptionalCustomElement;
  readonly lazyCustomElements = new LazyCustomElementRequestController(
    this,
    () => this.shellChrome.cancelPendingLazyAction(),
    (canReload) => this.shellChrome.retryPendingLazyAction(canReload),
  );
  // Gates lazy-action replay on the element being rendered; while the shell is
  // still splash-gated, replaying would loop through the open handlers forever.
  readonly queryRenderedElement = (tagName: string): Element | null =>
    this.element.querySelector(tagName);
  get commandPalette(): CommandPaletteElement | undefined {
    return this.querySelector<CommandPaletteElement>("openclaw-command-palette") ?? undefined;
  }
  get approvalOverlay(): (HTMLElement & { show(): void; dialogOpen?: boolean }) | undefined {
    return (
      this.querySelector<HTMLElement & { show(): void; dialogOpen?: boolean }>(
        "openclaw-exec-approval",
      ) ?? undefined
    );
  }
  commandPaletteTarget: CommandPaletteTargetDetail | undefined;
  navDrawerTrigger: HTMLElement | null = null;
  // Desktop and modal navigation are two slots for the same live sidebar.
  // Moving its element preserves session controllers and the resident pet
  // instead of resetting their lifecycle at every responsive breakpoint.
  readonly navigationSidebar: HTMLElement &
    Partial<Pick<AppSidebarBase, "navigationVisible" | "updateComplete">> = document.createElement(
    APP_SIDEBAR_ELEMENT.tagName,
  );
  // Where "Back to app" / Escape leaves the settings takeover; falls back to
  // chat (the app default route) when settings was the entry point.
  lastWorkspaceLocation: ShellNavigationHost["lastWorkspaceLocation"] = null;
  custodianMinimizeRequestId = 0;
  lastConcreteRouteId: RouteId | undefined;
  lastLocalePrefSignature: string | null = null;
  outboxStoreRuntime: OutboxStoreRuntime | null = null;
  storedOutboxes: ReturnType<OutboxStoreRuntime["read"]> | undefined;
  private outboxStoreUnsubscribe: (() => void) | null = null;
  private lastDeletedSessions: ApplicationContext["sessions"]["state"]["deletedSessions"] | null =
    null;
  readonly outboxStoreImport = createIdleImport(
    () =>
      import("../lib/chat/outbox-store-projection.ts").then((module) =>
        module.createStoredChatOutboxReader(),
      ),
    (runtime) => this.installOutboxStoreRuntime(runtime),
  );
  private lastNativeNavState: NativeNavState | undefined;
  didConsiderNativeRouteRestore = false;
  pendingNativeNewSession = false;
  readonly settingsPreloadTimers = new Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>();
  // Settings navigation is needed only after entering the settings takeover.
  // Keep its search, update-card, and sidebar rendering graph off the startup path.
  readonly settingsSidebar = new LazyRenderer(this, () =>
    import("../components/settings-sidebar.ts").then((module) => module.renderSettingsSidebar),
  );
  readonly debugOverlayFrame = new LazyRenderer(this, () =>
    import("../pages/debug/debug-overlay-frame.ts").then(
      (module) => module.renderPendingDebugOverlay,
    ),
  );
  private readonly sidebarUpdateCardImport = createIdleImport(
    () => import("../components/sidebar-update-card.ts"),
  );

  // Lazy: the pairing modal is opened from Settings, not at
  // boot, so its template, icons, and strings stay off the startup chunk.
  // A rejected chunk must stay visible: the overlay is already open, so the
  // shell renders a recoverable failure instead of an empty dialog frame.
  readonly devicePairSetup = new LazyRenderer(this, () =>
    import("../pages/devices/view-pairing.runtime.ts").then(
      (module) => module.renderDevicePairSetup,
    ),
  );
  private readonly shellNavigation = new ShellNavigationOwner(this);
  private readonly shellChrome = new ShellChromeOwner(this);
  private readonly shellGateway = new ShellGatewayOwner(this);
  readonly viewCallbacks = createShellViewCallbacks(this);

  get context(): ApplicationContext | undefined {
    return this.runtime?.context;
  }

  get onboardingMode(): boolean {
    const routeSearch = this.routeState.location?.search;
    return routeSearch === undefined ? this.onboarding : resolveOnboardingMode(routeSearch);
  }

  private get workspaceChromeVisible(): boolean {
    const routeId = this.routeState.routeId;
    // Hidden workspace chrome must not preload its sidebar and panel graphs.
    return routeId !== undefined && !isSettingsNavigationRoute(routeId) && !this.onboardingMode;
  }

  storedOutboxScopeHost(context: ApplicationContext): StoredOutboxScopeHost {
    const gatewaySnapshot = context.gateway.snapshot;
    return {
      client: gatewaySnapshot.client,
      connected: gatewaySnapshot.phase === "connected",
      settings: { gatewayUrl: context.gateway.connection.gatewayUrl },
      assistantAgentId: gatewaySnapshot.assistantAgentId,
      agentsList: context.agents.state.agentsList,
      hello: gatewaySnapshot.hello,
    };
  }

  private chatTitleContext(
    context: ApplicationContext,
    outboxScopeHost: StoredOutboxScopeHost,
  ): string {
    const sessionKey = this.activeSessionKey;
    // An agent's main chat is its identity, so use its roster label when available.
    const parsed = parseAgentSessionKey(sessionKey);
    const mainAgentId = isUiGlobalSessionKey(sessionKey)
      ? resolveUiKnownSelectedGlobalAgentId(outboxScopeHost)
      : parsed?.rest === resolveUiConfiguredMainKey(outboxScopeHost)
        ? normalizeAgentId(parsed.agentId)
        : undefined;
    const agent = mainAgentId
      ? context.agents.state.agentsList?.agents.find(
          (candidate) => normalizeAgentId(candidate.id) === mainAgentId,
        )
      : undefined;
    return agent
      ? normalizeAgentLabel(agent)
      : resolveSessionDisplayName(
          sessionKey,
          context.sessions.presentation.result?.sessions.find(
            (session) => session.key === sessionKey,
          ),
        );
  }

  constructor(
    public element: HTMLElement,
    runtime?: ApplicationRuntime,
    readiness?: ControlUiReadiness,
    onboarding = false,
  ) {
    super();
    this.runtime = runtime;
    this.readiness = readiness;
    this.onboarding = onboarding;
  }

  get querySelector(): HTMLElement["querySelector"] {
    return this.element.querySelector.bind(this.element);
  }
  readonly querySelectorAll = <T extends Element = Element>(selector: string): NodeListOf<T> =>
    this.element.querySelectorAll<T>(selector);
  get isConnected() {
    return this.element.isConnected;
  }
  // Temporary callback ABI used by unported lazy-element and layout owners.
  readonly requestUpdate = () => this.invalidate();

  replaceRuntime(runtime: ApplicationRuntime): void {
    if (runtime.context !== this.context) {
      this.shellChrome.abandonPendingLazyActionForContext();
      this.resetShellState();
    }
    this.runtime = runtime;
  }

  override invalidate(): void {
    this.readiness?.invalidate();
    super.invalidate();
  }

  connect(): void {
    const context = this.context;
    this.resumePresentation();
    const runtime = this.runtime;
    if (context && runtime) {
      const watch = (
        projection: { subscribe(listener: () => void): () => void; dispose(): void },
        synchronize?: () => void,
      ) => {
        const publish = () => {
          synchronize?.();
          this.invalidate();
        };
        const unsubscribe = projection.subscribe(publish);
        this.cleanups.push(() => {
          unsubscribe();
          projection.dispose();
        });
        publish();
      };
      watch(projectGateway(context.gateway), () => {
        this.shellChrome.synchronizeCommandPaletteScope();
        this.shellGateway.synchronizeGateway(context.gateway.snapshot);
        this.refreshStoredOutboxSummary();
      });
      watch(projectApplicationConfig(context.config));
      watch(
        projectSource(context.navigation, {
          read: (navigation) => navigation.snapshot,
          subscribe: (navigation, notify) => navigation.subscribe(notify),
          equality: "revision",
        }),
      );
      watch(projectAgentSelection(context.agentSelection));
      watch(projectAgentSelection(context.settingsAgentSelection));
      watch(projectAgents(context.agents), () => {
        this.refreshStoredOutboxSummary();
        this.ensureAgentsList(context.gateway.snapshot, context.agents);
      });
      watch(
        projectSource(context.overlays, {
          read: (overlays) => overlays.snapshot,
          subscribe: (overlays, notify) => overlays.subscribe(notify),
          equality: "revision",
        }),
      );
      watch(projectI18n(i18n));
      const theme = projectTheme(context.theme);
      watch(theme.preferences);
      watch(theme.appliedPalette);
      watch(projectRuntimeConfig(context.runtimeConfig), () => {
        this.ensureRuntimeConfig(context.gateway.snapshot, context.runtimeConfig);
        void this.shellGateway.reconcileServerUiPrefs(context.runtimeConfig);
      });
      const shellRoute = projectSource(runtime.router, {
        read: (router) => selectShellRouteState(router.getState()),
        subscribe: (router, notify) => router.subscribe(notify),
        equality: equalShellRouteState,
      });
      watch(shellRoute, () => this.shellNavigation.updateRouteState(shellRoute.read()));
      for (const source of [context.plugins, context.agentIdentity, context.nativeDeviceSettings]) {
        if (source) {
          this.cleanups.push(source.subscribe(() => this.invalidate()));
        }
      }
      this.cleanups.push(
        context.gateway.subscribeEvents(this.handleGatewayEvent),
        this.shellGateway.observeSessions(context.sessions, () => this.syncDocumentTitle()),
        context.placementStartup.subscribe(() => this.recoverDeletedActiveSession()),
      );
      let active = true;
      let disconnectFavicon: (() => void) | undefined;
      const startedAt = Date.now();
      const favicon = createIdleImport(
        () => import("./control-ui-favicon-status.runtime.ts"),
        ({ connectControlUiFavicon }) => {
          if (active) {
            disconnectFavicon = connectControlUiFavicon(this.element, context, startedAt);
          }
        },
      );
      favicon.schedule();
      this.cleanups.push(() => {
        active = false;
        favicon.dispose();
        disconnectFavicon?.();
      });
      if (this.pendingNativeNewSession) {
        this.pendingNativeNewSession = false;
        this.handleNativeNewSession();
      }
    }
    if (this.outboxStoreRuntime) {
      this.installOutboxStoreRuntime(this.outboxStoreRuntime);
    }
    this.outboxStoreImport.schedule();
    this.shellChrome.connect();
    // Write-through of synced display prefs to config ui.prefs. Server-applied
    // deltas are suppressed so a reconcile never echoes back to the gateway.
    setSettingsChangeListener((previous, next) => {
      if (isApplyingServerUiPrefs()) {
        return;
      }
      const prefs = changedServerUiPrefs(previous, next);
      const runtimeConfig = this.context?.runtimeConfig;
      if (prefs && runtimeConfig) {
        pushServerUiPrefs(runtimeConfig, prefs, {
          profile: this.context?.gateway.snapshot,
          afterCommit: ({ needsRefresh, retainedLocal }) => {
            void this.shellGateway.reconcileCommittedServerUiPrefs(
              runtimeConfig,
              needsRefresh,
              retainedLocal,
            );
          },
        });
      }
    });
  }

  disconnect(): void {
    this.suspendPresentation();
    for (const cleanup of this.cleanups.splice(0).toReversed()) {
      cleanup();
    }
    this.shellLayout.hostDisconnected();
    this.shellChrome.disconnect();
    syncControlUiSystemChrome();
    this.outboxStoreImport.dispose();
    this.sidebarUpdateCardImport.dispose();
    this.outboxStoreUnsubscribe?.();
    this.outboxStoreUnsubscribe = null;
    this.lastLocalePrefSignature = null;
    setSettingsChangeListener(null);
    this.resetForDocumentDisconnect();
  }

  private installOutboxStoreRuntime(runtime: OutboxStoreRuntime) {
    this.outboxStoreRuntime = runtime;
    runtime.invalidate();
    if (!this.isConnected) {
      return;
    }
    this.outboxStoreUnsubscribe?.();
    this.outboxStoreUnsubscribe = runtime.subscribe(this.refreshStoredOutboxPresentation);
    this.refreshStoredOutboxPresentation();
  }

  private refreshStoredOutboxSummary() {
    const context = this.context;
    this.storedOutboxes = context
      ? this.outboxStoreRuntime?.read(this.storedOutboxScopeHost(context))
      : undefined;
    context?.nativeConversation?.publishSessionFacts(this.storedOutboxes?.sessions ?? null);
  }

  private readonly refreshStoredOutboxPresentation = () => {
    this.refreshStoredOutboxSummary();
    this.invalidate();
  };

  private resetForDocumentDisconnect() {
    this.shellChrome.preservePendingLazyActionForReload();
    this.resetShellState();
  }

  private resetShellState() {
    this.outboxStoreRuntime?.invalidate();
    this.navDrawerOpen = false;
    this.desktopNavigationExpanded = false;
    this.navDrawerTrigger = null;
    this.lastWorkspaceLocation = null;
    this.activeSessionKey = "";
    this.settingsSearchQuery = "";
    this.commandPaletteTarget = undefined;
    this.lastDeletedSessions = null;
    this.storedOutboxes = undefined;
    this.shellGateway.reset();
    for (const timer of this.settingsPreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.settingsPreloadTimers.clear();
  }

  readonly selectChatSession = this.shellNavigation.selectChatSession.bind(this.shellNavigation);
  private readonly handleGatewayEvent = this.shellGateway.handleGatewayEvent.bind(
    this.shellGateway,
  );

  readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) {
      return;
    }
    context.theme.setMode(event.detail.mode, event.detail.element);
  };

  async handleSettingsSearchQueryChange(nextQuery: string): Promise<void> {
    this.settingsSearchQuery = nextQuery;
    const runtimeConfig = this.context?.runtimeConfig;
    if (!runtimeConfig || !nextQuery.trim()) {
      return;
    }
    try {
      await runtimeConfig.ensureLoaded();
      if (this.context?.runtimeConfig === runtimeConfig) {
        await runtimeConfig.ensureSchemaLoaded();
      }
    } catch {
      // Runtime config state owns the visible load error; search stays usable.
    }
  }

  readonly chatNavigationOptions = this.shellNavigation.chatNavigationOptions.bind(
    this.shellNavigation,
  );

  readonly navigate = this.shellNavigation.navigate;

  readonly recoverNotFoundRoute = this.shellNavigation.recoverNotFoundRoute.bind(
    this.shellNavigation,
  );
  readonly recoverDeletedActiveSession = this.shellNavigation.recoverDeletedActiveSession.bind(
    this.shellNavigation,
  );

  observeDeletedSessions(sessionState: ApplicationContext["sessions"]["state"]): void {
    const context = this.context;
    const deletedSessions = sessionState.deletedSessions;
    if (!context || Object.is(deletedSessions, this.lastDeletedSessions)) {
      return;
    }
    this.lastDeletedSessions = deletedSessions;
    if (deletedSessions.length === 0) {
      return;
    }
    const { client, assistantAgentId, hello } = context.gateway.snapshot;
    // Handoffs belong to this synchronous deletion observation, not the later storage import.
    retireSessionPaneHandoffs(context, deletedSessions);
    for (const { key, agentId, retireBeforeRevision } of deletedSessions) {
      context.chatAttachmentHandoff.retireScope(
        storedChatOutboxScopeKey({ sessionKey: key, agentId }),
        retireBeforeRevision,
      );
    }
    const gatewayUrl = context.gateway.connection.gatewayUrl;
    const sameConnection = capturePlacementStartupConnection(context.gateway, {
      gatewayUrl,
      recoveryScope: client?.recoveryScope || undefined,
    });
    const scope = {
      client,
      gatewayUrl,
      isCurrent: () => context.gateway.snapshot.client === client && sameConnection(),
      assistantAgentId,
      hello,
      agentsList: context.agents.state.agentsList,
    };
    void import("../lib/chat/composer-draft-retirement.runtime.ts").then(
      ({ retireDeletedComposerDrafts }) =>
        retireDeletedComposerDrafts(context, scope, deletedSessions),
      () => showToast({ message: t("sessionsView.draftCleanupFailed") }),
    );
  }

  readonly exitSettings = this.shellNavigation.exitSettings.bind(this.shellNavigation);

  readonly toggleNavigationSurface = this.shellChrome.toggleNavigationSurface;

  readonly closeNavDrawer = this.shellChrome.closeNavDrawer;

  readonly resizeNavigation = this.shellChrome.resizeNavigation;

  readonly openNewSession = this.shellNavigation.openNewSession.bind(this.shellNavigation);

  // Shipped Mac app builds without web chrome still drive these handlers.
  readonly handleNativeToggleSidebar = this.shellChrome.handleNativeToggleSidebar;
  readonly handleNativeOpenSearch = this.shellChrome.handleNativeOpenSearch;
  readonly handleNativeToggleSearch = this.shellChrome.handleNativeToggleSearch;
  readonly handleNativeNewSession = this.shellChrome.handleNativeNewSession;
  readonly handleNativeNavigate = this.shellChrome.handleNativeNavigate;
  readonly handleWindowResize = this.shellChrome.handleWindowResize;
  readonly handleDocumentKeydown = this.shellChrome.handleDocumentKeydown;
  get pendingDebugOverlayMode() {
    return this.shellChrome.pendingDebugOverlayMode;
  }
  readonly togglePendingDebugOverlayMode = this.shellChrome.togglePendingDebugOverlayMode.bind(
    this.shellChrome,
  );
  readonly openPalette = this.shellChrome.openPalette;
  readonly closePendingPalette = this.shellChrome.closePendingPalette;
  get commandPaletteLoading() {
    return this.shellChrome.commandPaletteLoading;
  }
  readonly refreshControlUi = (): Promise<boolean> => {
    const context = this.context;
    if (!context) {
      return Promise.resolve(false);
    }
    return retryStaleChunkReloadWhenReachable({
      timeoutMs: 0,
      ...createGatewayControlUiReloadOptions(
        context.gateway,
        () => this.context === context && context.overlays.snapshot.controlUiRefreshRequired,
      ),
    });
  };
  readonly handleShellNavDrawerToggle = this.shellChrome.handleShellNavDrawerToggle;
  readonly handleCommandPaletteSlashCommand = this.shellChrome.handleCommandPaletteSlashCommand;
  readonly restorePendingLazyAction = this.shellChrome.restorePendingLazyAction;
  readonly nativeNavCollapsed = this.shellChrome.nativeNavCollapsed;
  /** Session publications update the title directly; renders capture route and
   * locale changes. Preserve the static boot title before the first route. */
  private syncDocumentTitle() {
    const routeId = this.routeState.routeId;
    const context = this.context;
    if (!routeId || !context) {
      return;
    }
    const outboxScopeHost = this.storedOutboxScopeHost(context);
    let primaryContext = routeId === "custodian" ? askBrandLabel() : titleForRoute(routeId);
    if (isSessionRouteId(routeId) && this.activeSessionKey) {
      primaryContext = this.chatTitleContext(context, outboxScopeHost) || primaryContext;
    }
    const { phase, lastError } = context.gateway.snapshot;
    // A warm shell renders before hello; initial loading is not a lost connection.
    const gatewayDisconnected =
      phase !== "connected" &&
      (Boolean(lastError) ||
        phase === "reconnecting" ||
        phase === "offline" ||
        phase === "reload-required");
    let title = formatDocumentTitle({
      context: primaryContext,
      brandName: context.theme.branding.brandName,
      attentionCount: phase === "connected" ? context.overlays.snapshot.approvalQueue.length : 0,
      gatewayDisconnected,
    });
    const environment = context.config?.current.environment;
    if (environment) {
      title += ` · ${environment.label}`;
    }
    if (document.title !== title) {
      document.title = title;
    }
  }

  afterCommit(): void {
    this.commitPresentation();
    this.syncDocumentTitle();
    // Theme and breakpoint owners sync their changes; route/runtime changes
    // can change whether the committed shell uses the chat background.
    syncControlUiSystemChrome();
    // Render-gated pending lazy actions replay on the update that first
    // renders their element, independent of further context updates.
    this.restorePendingLazyAction();
    if (
      !customElements.get("openclaw-sidebar-update-card") &&
      this.querySelector("openclaw-sidebar-update-card")
    ) {
      void this.sidebarUpdateCardImport.load().catch((error: unknown) => {
        if (isStaleChunkImportError(error)) {
          void scheduleStaleChunkReload();
        }
      });
    }
    const chatPage = this.querySelector<ChatPage>("openclaw-chat-page");
    if (chatPage) {
      chatPage.navDrawerOpen = this.navDrawerOpen && !this.onboardingMode;
    }
    const context = this.context;
    if (!context) {
      return;
    }
    if (this.querySelector(".settings-sidebar__agent")) {
      void context.agentIdentity.ensure([context.settingsAgentSelection.state.selectedId]);
    }
    if (this.workspaceChromeVisible) {
      this.shellChrome.panels.restore();
    }
    if ((context.overlays?.snapshot.approvalQueue.length ?? 0) > 0) {
      this.lazyCustomElements.preload(this.execApprovalElement);
    }
    this.restorePendingLazyAction();
    const navState = {
      collapsed: this.nativeNavCollapsed(),
      width: context.navigation.snapshot.navWidth,
    } satisfies NativeNavState;
    if (
      navState.collapsed === this.lastNativeNavState?.collapsed &&
      navState.width === this.lastNativeNavState.width
    ) {
      return;
    }
    this.lastNativeNavState = navState;
    // Shipped Mac app builds without web chrome still consume this bridge.
    postNativeNavState(navState);
  }

  private ensureRuntimeConfig(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    runtimeConfig = this.context?.runtimeConfig,
  ) {
    void this.shellGateway.ensureRuntimeConfig(snapshot, runtimeConfig).catch(() => undefined);
  }

  readonly newSessionRouteAgentId = this.shellNavigation.newSessionRouteAgentId.bind(
    this.shellNavigation,
  );

  ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents = this.context?.agents,
  ) {
    void this.shellGateway.ensureAgentsList(snapshot, agents).catch(() => undefined);
  }

  prepareView(): void {
    this.refreshStoredOutboxSummary();
    if (this.workspaceChromeVisible) {
      this.lazyCustomElements.preload(APP_SIDEBAR_ELEMENT);
    }
  }
}

export type OpenClawShellProps = {
  runtime: ApplicationRuntime;
  getReadiness?: () => ControlUiReadiness | undefined;
  onboarding?: boolean;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-app-shell": HTMLAttributes<HTMLElement>;
    }
  }
}

export function OpenClawShell(props: OpenClawShellProps): SolidJSX.Element {
  const componentOwner = getOwner();
  const element = document.createElement("openclaw-app-shell");
  const owner = untrack(
    () => new ShellOwner(element, props.runtime, props.getReadiness?.(), props.onboarding),
  );
  // Effect callbacks are unowned; each runtime epoch owns and retires its projections.
  createEffect(
    () => props.runtime,
    (runtime) =>
      runWithOwner(componentOwner, () =>
        createRoot((dispose) => {
          owner.replaceRuntime(runtime);
          owner.connect();
          return () => {
            owner.disconnect();
            dispose();
          };
        }),
      ),
  );
  createEffect(
    () => owner.shellRevision(),
    () => {
      owner.afterCommit();
    },
  );
  const view = renderApplicationShell(owner);
  return (
    <openclaw-app-shell
      ref={(host) => {
        owner.element = host;
        // The optional observer reads committed owner facts without rendering the shell again.
        Object.defineProperties(host, {
          readiness: {
            get: () => owner.readiness,
            set: (value: ControlUiReadiness | undefined) => {
              owner.readiness = value;
            },
          },
          updateComplete: { get: () => owner.updateComplete },
          navigationSidebar: { get: () => owner.navigationSidebar },
          activeSessionKey: { get: () => owner.activeSessionKey },
        });
      }}
    >
      {view}
    </openclaw-app-shell>
  );
}
