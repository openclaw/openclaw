import { consume } from "@lit/context";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import { mergeChatPageChrome, mobileNavLayoutMediaQuery } from "../../app/mobile-nav-layout.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { McpAppUnmountGate } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { readSessionDragData, sessionDragActive } from "../../lib/sessions/drag.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { stillOwnsCanonicalLocation } from "./chat-canonical-location.ts";
import { ChatPageCloseFocus } from "./chat-page-close-focus.ts";
import { resolveDropIndicator, type DropIndicator } from "./chat-page-drop-indicator.ts";
import {
  navigateChatPage,
  handleChatPageCommand,
  ownedChatPaneRouteData,
  ownedChatPaneSessionKey,
  sameChatPaneRoute,
} from "./chat-page-navigation.ts";
import {
  renderPendingChatPage,
  renderChatPageBody,
  renderChatPagePaneCell,
  renderChatPageSplitLayout,
} from "./chat-page-pane-render.ts";
import { ChatPageRetainedSessions } from "./chat-page-retained-sessions.ts";
import { closeStagedPane, resumeStagedPanes } from "./chat-pane-attachment-handoff.ts";
import { bindChatPageSession } from "./chat-state-route.ts";
import { ChatViewerPresenceController } from "./chat-viewer-presence.ts";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "./chat-pane.ts";
import { RouteDraftComposerFocus, type ChatPaneElement } from "./route-draft-focus-handoff.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import { installSessionPrefetch } from "./session-prefetch.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import type { ChatSplitLayout, ChatSplitPane, SessionSplitHost } from "./split-layout-types.ts";
import {
  closePane,
  findPane,
  insertPane,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  singlePaneLayout,
} from "./split-layout.ts";

export class ChatPage extends OpenClawLightDomElement implements SessionSplitHost {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) data!: SessionChatRouteData;
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ type: Boolean }) presented = true;
  @state() private layout: ChatSplitLayout | undefined;
  @state() private narrow = false;
  @state() private mergedChrome = false;
  @state() private dropIndicator: DropIndicator | null = null;

  private get pendingCreate(): boolean {
    return this.data?.creation?.admitted === false;
  }

  get sessionSplitAvailable(): boolean {
    return (
      this.presented &&
      !this.pendingCreate &&
      !this.narrow &&
      Boolean(this.data?.sessionKey?.trim())
    );
  }

  private mediaQuery: MediaQueryList | null = null;
  private mobileNavMediaQuery: MediaQueryList | null = null;
  private dragDepth = 0;
  private dragFrame = 0;
  private pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;
  private consumedDraftData: SessionChatRouteData | null = null;
  private get paneData(): SessionChatRouteData {
    return this.layout ? ownedChatPaneRouteData(this.context, this.data) : this.data;
  }

  private readonly draftFocus = new RouteDraftComposerFocus(this);
  private readonly messageCache: ChatMessageCache = new Map();
  private readonly snapshotStore = new SessionSnapshotStore(this.messageCache);
  private classicColumnId = "c1";
  private classicPaneId = "p1";
  private routeHref = "";
  private unboundRoute: SessionChatRouteData | undefined;
  private readonly closeFocus = new ChatPageCloseFocus(this);
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);
  private readonly viewerPresence = new ChatViewerPresenceController(this);
  private readonly retainedSessions = new ChatPageRetainedSessions(this, {
    context: () => this.context,
    presented: () => this.presented,
    routeHref: () => this.routeHref,
    layout: () => this.layout ?? this.classicLayout(),
    narrow: () => this.narrow,
    selectReplacement: (paneId, sourceSessionKey, sessionKey) =>
      this.handlePaneSessionChange(paneId, sourceSessionKey, sessionKey),
    adoptNavigation: (paneId, sessionKey, agentId) =>
      this.adoptPaneNavigation(paneId, sessionKey, agentId),
  });

  constructor() {
    super();
    new SubscriptionsController(this)
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        undefined,
        () => this.performUpdate(),
      )
      .watch(
        () => this.context?.chatSubmissions,
        (submissions, notify) => submissions.subscribeCreate(notify),
      )
      .watch(
        () => this.context?.placementStartup,
        (startup, notify) => startup.subscribe(notify),
      )
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
      );
    installSessionPrefetch(this, this.messageCache, this.snapshotStore, () => this.context);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.snapshotStore.connect();
    observeChatCache(this.messageCache, this.snapshotStore);
    this.routeHref = window.location.href;
    this.layout = loadSettings().chatSplitLayout;
    this.retainedSessions.restore(this.layout ? panesOf(this.layout) : []);
    this.unboundRoute =
      this.layout && this.retainedSessions.unboundPaneIds.has(this.layout.activePaneId)
        ? this.paneData
        : undefined;
    this.mediaQuery = window.matchMedia("(max-width: 1099px)");
    this.narrow = this.mediaQuery.matches;
    this.mediaQuery.addEventListener("change", this.handleViewportChange);
    this.mobileNavMediaQuery = window.matchMedia(mobileNavLayoutMediaQuery());
    this.mergedChrome = this.resolveMergedChrome(this.mobileNavMediaQuery.matches);
    this.mobileNavMediaQuery.addEventListener("change", this.handleMobileNavViewportChange);
    this.addEventListener("dragenter", this.handleDragEnter);
    this.addEventListener("dragover", this.handleDragOver);
    this.addEventListener("dragleave", this.handleDragLeave);
    this.addEventListener("drop", this.handleDrop);
    window.addEventListener("dragend", this.clearDropIndicator);
    window.addEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    this.retainedSessions.connect();
    this.syncRouteToActivePane();
    this.syncRouteBindings();
    const layout = this.layout ?? this.classicLayout();
    if (this.presented && !this.pendingCreate) {
      this.viewerPresence.sync(
        this.context?.gateway,
        layout,
        this.narrow,
        this.retainedSessions.unboundPaneIds,
      );
    }
  }

  override disconnectedCallback() {
    this.closeFocus.clear();
    this.snapshotStore.disconnect();
    this.retainedSessions.disconnect();
    this.viewerPresence.dispose();
    this.mediaQuery?.removeEventListener("change", this.handleViewportChange);
    this.mediaQuery = null;
    this.mobileNavMediaQuery?.removeEventListener("change", this.handleMobileNavViewportChange);
    this.mobileNavMediaQuery = null;
    this.removeEventListener("dragenter", this.handleDragEnter);
    this.removeEventListener("dragover", this.handleDragOver);
    this.removeEventListener("dragleave", this.handleDragLeave);
    this.removeEventListener("drop", this.handleDrop);
    window.removeEventListener("dragend", this.clearDropIndicator);
    window.removeEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    this.clearDropIndicator();
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    if (!this.presented || this.pendingCreate) {
      this.closeFocus.clear();
      this.viewerPresence.dispose();
      if (changedProperties.has("presented")) {
        this.retainedSessions.suspend();
        this.clearDropIndicator();
      }
      return;
    }
    const layout = this.layout ?? this.classicLayout();
    resumeStagedPanes(this, layout, this.narrow);
    if (this.isConnected) {
      this.viewerPresence.sync(
        this.context?.gateway,
        layout,
        this.narrow,
        this.retainedSessions.unboundPaneIds,
      );
    }
    this.closeFocus.restore(this.layout, this.mcpAppUnmountGate.retiring);
    const data = this.paneData;
    const activePane = this.layout ? findPane(this.layout, this.layout.activePaneId)?.pane : null;
    const activeSessionKey = this.layout ? (activePane?.sessionKey ?? null) : undefined;
    const routeHandoffRendered = this.draftFocus.rendered(
      data,
      activeSessionKey,
      this.consumedDraftData,
    );
    if (data && (changedProperties.has("data") || changedProperties.has("presented"))) {
      this.routeHref = window.location.href;
      if (
        data?.canonicalLocation &&
        stillOwnsCanonicalLocation(data.canonicalLocationSource, this.consumedDraftData === data)
      ) {
        // Move a route matched under the wrong namespace to its resolved board face.
        this.context.replace(data.face ?? "chat", data.canonicalLocation);
        return;
      }
      void data?.canonicalLocationReady?.then((location) => {
        if (
          location &&
          this.isConnected &&
          this.presented &&
          this.paneData === data &&
          stillOwnsCanonicalLocation(data.canonicalLocationSource, this.consumedDraftData === data)
        ) {
          // A lazy canonicalization must never replace a newer route.
          this.context.replace(
            data.face ?? "chat",
            this.consumedDraftData === data ? locationWithoutDraft(location) : location,
          );
        }
      });
      this.syncRouteToActivePane();
      this.syncRouteBindings();
      this.retainedSessions.settleRoute();
    }
    if (data && routeHandoffRendered) {
      const pane = this.retainedSessions.findPane(layout.activePaneId, data.sessionKey);
      if (!pane) {
        return;
      }
      // A retained pane can defer its commit beyond the page's update. Keep
      // the one-shot properties until that pane has consumed them.
      void Promise.resolve(pane.updateComplete).then(() => {
        if (
          this.isConnected &&
          this.presented &&
          pane.active &&
          pane.presented &&
          this.retainedSessions.findPane(
            (this.layout ?? this.classicLayout()).activePaneId,
            data.sessionKey,
          ) === pane &&
          this.paneData === data &&
          this.consumedDraftData !== data
        ) {
          this.draftFocus.beforeDraftCleanup(data);
          this.consumedDraftData = data;
          this.updateRoute(data.sessionKey, true, data.face ?? "chat");
          this.requestUpdate();
        }
      });
    }
  }

  private readonly handleViewportChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
    if (event.matches) {
      this.clearDropIndicator();
    }
  };

  private resolveMergedChrome(mobileNavLayout: boolean): boolean {
    return mergeChatPageChrome(mobileNavLayout, this.closest(".shell--onboarding") !== null);
  }

  private readonly handleMobileNavViewportChange = (event: MediaQueryListEvent) => {
    this.mergedChrome = this.resolveMergedChrome(event.matches);
  };

  private readonly handleUiCommand = (event: Event) =>
    handleChatPageCommand(event, {
      context: this.context,
      data: this.data,
      presented: this.presented,
      pendingCreate: this.pendingCreate,
      narrow: this.narrow,
      layout: this.layout,
      unboundPaneIds: this.retainedSessions.unboundPaneIds,
      classicLayout: (key) => this.classicLayout(key),
      adoptPaneNavigation: (paneId, key, agentId) => this.adoptPaneNavigation(paneId, key, agentId),
      updateRoute: (key, replace, face, agentId) => this.updateRoute(key, replace, face, agentId),
      closeSplitPane: (layout, paneId) => this.closeSplitPane(layout, paneId),
      persistLayout: (layout) => this.persistLayout(layout),
      updateRouteToPane: (pane) => this.updateRouteToPane(pane),
    });

  private readonly handleDragEnter = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth += 1;
  };

  private readonly handleDragOver = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    if (!pane || !this.contains(pane)) {
      this.clearDropIndicator();
      return;
    }
    this.pendingDragOver = { pane, x: event.clientX, y: event.clientY };
    if (this.dragFrame) {
      return;
    }
    this.dragFrame = window.requestAnimationFrame(() => {
      this.dragFrame = 0;
      const pending = this.pendingDragOver;
      this.pendingDragOver = null;
      if (!pending || this.narrow || !this.isConnected) {
        return;
      }
      const indicator = resolveDropIndicator(this, pending.pane, pending.x, pending.y);
      if (!indicator) {
        this.clearDropIndicator();
        return;
      }
      const current = this.dropIndicator;
      if (
        current?.paneId === indicator.paneId &&
        current.zone.kind === indicator.zone.kind &&
        (indicator.zone.kind === "center" ||
          (current.zone.kind === "edge" && current.zone.edge === indicator.zone.edge))
      ) {
        return;
      }
      this.dropIndicator = indicator;
    });
  };

  private readonly handleDragLeave = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.clearDropIndicator();
    }
  };

  private readonly handleDrop = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const sessionKey = readSessionDragData(event.dataTransfer);
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    const indicator =
      pane && this.contains(pane)
        ? resolveDropIndicator(this, pane, event.clientX, event.clientY)
        : null;
    this.clearDropIndicator();
    if (sessionKey && indicator) {
      this.applySessionDrop(sessionKey, indicator.paneId, indicator.zone);
    }
  };

  private readonly clearDropIndicator = () => {
    this.dragDepth = 0;
    this.pendingDragOver = null;
    if (this.dragFrame) {
      window.cancelAnimationFrame(this.dragFrame);
      this.dragFrame = 0;
    }
    this.dropIndicator = null;
  };

  private syncRouteToActivePane() {
    const layout = this.layout;
    const sessionKey = this.paneData?.sessionKey?.trim();
    if (!layout || !sessionKey || this.pendingCreate) {
      return;
    }
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (!activePane || activePane.sessionKey === sessionKey) {
      return;
    }
    // A refresh of the old route is not a conversation choice for an unbound pane.
    if (
      this.retainedSessions.unboundPaneIds.has(activePane.id) &&
      this.retainedSessions.wasPendingAtFocus()
    ) {
      this.unboundRoute = this.paneData;
    }
    if (
      this.retainedSessions.unboundPaneIds.has(activePane.id) &&
      sameChatPaneRoute(this.context, this.unboundRoute, this.paneData)
    ) {
      return;
    }
    this.retainedSessions.bindPane(activePane.id);
    this.persistLayout(setPaneSession(layout, activePane.id, sessionKey));
  }

  private syncRouteBindings(agentId = this.data?.agentId) {
    if (!this.presented || this.pendingCreate) {
      return;
    }
    const activePane = this.layout && findPane(this.layout, this.layout.activePaneId)?.pane;
    const routeKey = (activePane?.sessionKey ?? this.data?.sessionKey)?.trim();
    if (
      this.context &&
      routeKey &&
      (!activePane || !this.retainedSessions.unboundPaneIds.has(activePane.id))
    ) {
      bindChatPageSession(this.context, routeKey, agentId);
    }
  }

  private adoptPaneNavigation(paneId: string, sessionKey: string, agentId?: string): void {
    if (!this.layout || (isUiGlobalSessionKey(sessionKey) && !agentId?.trim())) {
      return;
    }
    this.retainedSessions.bindPane(paneId);
    this.unboundRoute = undefined;
    this.persistLayout(
      setPaneSession(
        this.layout,
        paneId,
        ownedChatPaneSessionKey(this.context, sessionKey, agentId),
      ),
      agentId,
    );
  }

  private persistLayout(layout: ChatSplitLayout | undefined, agentId?: string) {
    this.layout = layout;
    patchSettings({ chatSplitLayout: layout });
    this.syncRouteBindings(agentId);
  }

  private updateRoute(
    sessionKey: string,
    replace = false,
    explicitFace?: BoardFace,
    agentId?: string,
  ) {
    if (this.presented) {
      navigateChatPage(this.context, this.data, sessionKey, replace, explicitFace, agentId);
    }
  }

  private updateRouteToPane(pane: ChatSplitPane): void {
    if (this.retainedSessions.unboundPaneIds.has(pane.id)) {
      this.retainedSessions.capturePendingNavigation();
      this.unboundRoute = this.paneData;
      return;
    }
    this.unboundRoute = undefined;
    const mounted = this.retainedSessions.findPane(pane.id, pane.sessionKey);
    this.updateRoute(pane.sessionKey, true, mounted?.captureNavigationFace?.());
  }

  private applySessionDrop(sessionKey: string, paneId: string, zone: SplitDropZone): void {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return;
    }
    if (!this.layout && zone.kind === "center") {
      this.updateRoute(trimmed);
      return;
    }
    // A classic edge drop starts a split; both modes then use the same layout operation.
    const layout =
      this.layout ??
      this.classicLayout(ownedChatPaneRouteData(this.context, this.data)?.sessionKey);
    const targetPaneId = this.layout ? paneId : this.classicPaneId;
    const pane = findPane(layout, targetPaneId)?.pane;
    if (!pane || (!this.layout && !pane.sessionKey)) {
      return;
    }
    if (zone.kind === "center") {
      if (pane.sessionKey === trimmed) {
        return;
      }
      const active = setActivePane(layout, targetPaneId);
      this.persistLayout(setPaneSession(active, targetPaneId, trimmed));
      this.updateRoute(trimmed, true);
      return;
    }
    this.persistLayout(insertPane(layout, targetPaneId, trimmed, zone.edge));
    this.updateRoute(trimmed, true);
  }

  private readonly handleFocusPane = (paneId: string, intent?: "review-edit") => {
    const layout = this.layout;
    const canFocus = this.presented || intent === "review-edit";
    if (!canFocus || !layout || layout.activePaneId === paneId) {
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane) {
      return;
    }
    this.persistLayout(setActivePane(layout, paneId));
    this.updateRouteToPane(pane);
  };

  private readonly handlePaneSessionChange = (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ): boolean => {
    let trimmed = sessionKey.trim();
    if (!this.presented || !trimmed || window.location.href !== this.routeHref) {
      return false;
    }
    const resolvedLayout = this.layout ?? this.classicLayout();
    const pane = findPane(resolvedLayout, paneId)?.pane;
    if (!pane || !areUiSessionKeysEquivalent(pane.sessionKey, sourceSessionKey)) {
      return false;
    }
    // Canonical wire spelling must not erase the Home owner kept by a split.
    if (
      this.layout &&
      isUiGlobalSessionKey(trimmed) &&
      resolveUiGlobalAliasAgentId(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
        },
        pane.sessionKey,
      )
    ) {
      trimmed = pane.sessionKey;
    }
    if (!this.layout) {
      if (areUiSessionKeysEquivalent(pane.sessionKey, trimmed)) {
        this.syncRouteBindings();
        return true;
      }
      this.updateRoute(trimmed, options?.replace);
      return true;
    }
    if (pane.sessionKey === trimmed) {
      return true;
    }
    this.persistLayout(setPaneSession(resolvedLayout, paneId, trimmed));
    if (resolvedLayout.activePaneId === paneId) {
      this.updateRoute(trimmed, options?.replace);
    }
    return true;
  };

  private readonly handlePaneFaceChange = (
    paneId: string,
    sessionKey: string,
    face: BoardFace,
  ): void => {
    if (!this.presented) {
      return;
    }
    const selectedSessionKey = findPane(this.layout ?? this.classicLayout(), paneId)?.pane
      .sessionKey;
    if (!selectedSessionKey || !areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      return;
    }
    if (
      (!this.layout || this.layout.activePaneId === paneId) &&
      areUiSessionKeysEquivalent(this.data.sessionKey, sessionKey) &&
      (this.data.face ?? "chat") === face
    ) {
      // Applying a dashboard default also announces its face. Keep the current
      // route intent; only explicit pane focus should supersede pending navigation.
      this.syncRouteBindings();
      return;
    }
    if (this.layout && this.layout.activePaneId !== paneId) {
      this.persistLayout(setActivePane(this.layout, paneId));
    }
    this.updateRoute(sessionKey, false, face);
  };

  private readonly openSplitView = () => {
    const sessionKey = ownedChatPaneRouteData(this.context, this.data)?.sessionKey?.trim();
    if (sessionKey) {
      this.persistLayout(
        insertPane(this.classicLayout(sessionKey), this.classicPaneId, sessionKey, "right"),
      );
    }
  };

  private handleSplit(paneId: string, direction: "right" | "down") {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(insertPane(layout, paneId, pane.sessionKey, direction));
  }

  private readonly handleSplitRight = (paneId: string) => this.handleSplit(paneId, "right");
  private readonly handleSplitDown = (paneId: string) => this.handleSplit(paneId, "down");

  private closeSplitPane(layout: ChatSplitLayout, paneId: string): void {
    const source = this.closeFocus.capture(paneId);
    const survivingPane = closeStagedPane(this.context, this, layout, paneId);
    this.retainedSessions.discardPane(paneId);
    const next = closePane(layout, paneId, this.retainedSessions.unboundPaneIds);
    if (!next && survivingPane) {
      const survivingLocation = findPane(layout, survivingPane.id);
      if (survivingLocation) {
        this.classicColumnId = survivingLocation.column.id;
        this.classicPaneId = survivingPane.id;
      }
    }
    this.persistLayout(next);
    const activePane = next ? findPane(next, next.activePaneId)?.pane : survivingPane;
    if (activePane) {
      this.updateRouteToPane(activePane);
      if (source) {
        this.closeFocus.schedule(source, activePane, next);
      }
    }
  }

  private readonly handleClosePane = (paneId: string) => {
    if (this.layout) {
      this.closeSplitPane(this.layout, paneId);
    }
  };

  private classicLayout(sessionKey = this.data?.sessionKey?.trim() ?? ""): ChatSplitLayout {
    return singlePaneLayout(this.classicColumnId, this.classicPaneId, sessionKey);
  }

  private renderSplitLayout(
    layout: ChatSplitLayout,
    splitMode: boolean,
    retainedSessions: ReadonlyMap<string, readonly (string | undefined)[]>,
  ) {
    return renderChatPageSplitLayout(layout, {
      narrow: this.narrow,
      renderPane: (column, pane, weight) =>
        renderChatPagePaneCell({
          active: this.presented && pane.id === layout.activePaneId,
          presented: this.presented,
          chatMessagesBySession: this.messageCache,
          sessionSnapshotStore: this.snapshotStore,
          consumedDraftData: this.consumedDraftData,
          context: this.context,
          data: this.paneData,
          draftFocus: this.draftFocus,
          mergedChrome: this.mergedChrome,
          narrow: this.narrow,
          navDrawerOpen: this.navDrawerOpen,
          onboarding: this.closest(".shell--onboarding") !== null,
          onClosePane: splitMode ? this.handleClosePane : undefined,
          onFaceChange: this.handlePaneFaceChange,
          onFocusPane: this.handleFocusPane,
          onOpenSplitView: splitMode || this.narrow ? undefined : this.openSplitView,
          onPaneSessionChange: this.handlePaneSessionChange,
          onSessionDeleted: this.retainedSessions.removeSession,
          onSplitDown: splitMode ? this.handleSplitDown : undefined,
          onSplitRight: splitMode ? this.handleSplitRight : undefined,
          ownerKey: JSON.stringify([column.id, pane.id]),
          pane,
          sessionSlots: retainedSessions.get(pane.id) ?? [],
          splitMode,
          unbound: this.retainedSessions.unboundPaneIds.has(pane.id),
          weight,
        }),
      onResizePanes: (columnId, paneIndex, ratio) => {
        this.layout = this.layout
          ? resizePanes(this.layout, columnId, paneIndex, ratio)
          : undefined;
      },
      onResizeColumns: (columnIndex, ratio) => {
        this.layout = this.layout ? resizeColumns(this.layout, columnIndex, ratio) : undefined;
      },
      onResizeEnd: () => this.persistLayout(this.layout),
    });
  }

  override render() {
    if (this.pendingCreate) {
      return this.mcpAppUnmountGate.render(
        "pending-create",
        () => renderPendingChatPage(this.context, this.data.sessionKey, this.presented),
        () => [...this.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")],
      );
    }
    const layout = this.layout ?? this.classicLayout();
    const retainedSessions = this.retainedSessions.retain(panesOf(layout));
    const nextPaneKeys = new Set<string>();
    for (const column of layout.columns) {
      for (const pane of column.panes) {
        const ownerKey = JSON.stringify([column.id, pane.id]);
        for (const sessionKey of retainedSessions.get(pane.id) ?? []) {
          if (
            sessionKey !== undefined &&
            (!this.context || !readDeletedSessionStartup(this.context, sessionKey))
          ) {
            nextPaneKeys.add(JSON.stringify([ownerKey, sessionKey]));
          }
        }
      }
    }
    const renderValue = () =>
      renderChatPageBody(
        this.renderSplitLayout(layout, Boolean(this.layout), retainedSessions),
        this.dropIndicator,
      );
    return this.mcpAppUnmountGate.render(JSON.stringify([...nextPaneKeys]), renderValue, () =>
      [...this.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].filter(
        (pane) => !nextPaneKeys.has(pane.dataset.mcpAppOwnerKey ?? ""),
      ),
    );
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
