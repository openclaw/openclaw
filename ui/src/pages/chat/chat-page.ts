import { consume } from "@lit/context";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { mergeChatPageChrome, mobileNavLayoutMediaQuery } from "../../app/mobile-nav-layout.ts";
import { nativeEmbedHost } from "../../app/native-web-chrome.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { McpAppUnmountGate } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { currentRouteLocation, stillOwnsCanonicalLocation } from "./chat-canonical-location.ts";
import { ChatPageCloseFocus } from "./chat-page-close-focus.ts";
import { ChatPageDropIndicator } from "./chat-page-drop-indicator.ts";
import {
  navigateChatPage,
  ownedChatPaneRouteData,
  ownedChatPaneSessionKey,
  sameChatPaneRoute,
} from "./chat-page-navigation.ts";
import {
  chatPagePaneOwnerKeys,
  renderPendingChatPage,
  renderChatPageBody,
  renderChatPagePaneCell,
  renderChatPageSplitLayout,
} from "./chat-page-pane-render.ts";
import { ChatPageRetainedSessions } from "./chat-page-retained-sessions.ts";
import { resumeStagedPanes } from "./chat-pane-attachment-handoff.ts";
import { bindChatPageSession } from "./chat-state-route.ts";
import { ChatViewerPresenceController } from "./chat-viewer-presence.ts";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "./chat-pane.ts";
import { RouteDraftComposerFocus, type ChatPaneElement } from "./route-draft-focus-handoff.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import { SessionPrefetchController } from "./session-prefetch.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import type { ChatSplitLayout, ChatSplitPane, SessionSplitHost } from "./split-layout-types.ts";
import {
  applyUiCommandToSplitLayout,
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

  private wasConversationPresented = false;
  private readonly nativeConversation = nativeEmbedHost()?.surface === "conversation";

  private get conversationPresented(): boolean {
    const presentation = this.context?.nativeConversation?.presentation;
    return this.presented && (!presentation || presentation.visible);
  }

  private get pendingCreate(): boolean {
    return this.data?.creation?.admitted === false;
  }

  get sessionSplitAvailable(): boolean {
    return (
      this.presented &&
      !this.pendingCreate &&
      !this.narrow &&
      !this.nativeConversation &&
      Boolean(this.data?.sessionKey?.trim())
    );
  }

  private mediaQuery: MediaQueryList | null = null;
  private mobileNavMediaQuery: MediaQueryList | null = null;
  private consumedDraftData: SessionChatRouteData | null = null;
  private get paneData(): SessionChatRouteData {
    return this.layout ? ownedChatPaneRouteData(this.context, this.data) : this.data;
  }

  private get singleBoundPane(): ChatSplitPane | undefined {
    const panes = this.layout ? panesOf(this.layout) : [];
    const pane = panes.length === 1 ? panes[0] : undefined;
    return pane && !this.retainedSessions.unboundPaneIds.has(pane.id) ? pane : undefined;
  }

  private readonly draftFocus = new RouteDraftComposerFocus(this);
  private readonly messageCache: ChatMessageCache = new Map();
  private readonly snapshotStore = new SessionSnapshotStore(this.messageCache);
  private classicColumnId = "c1";
  private classicPaneId = "p1";
  private routeHref = "";
  private unboundRoute: SessionChatRouteData | undefined;
  private processedRouteData: SessionChatRouteData | undefined;
  private readonly closeFocus = new ChatPageCloseFocus(this);
  private readonly sessionDrop = new ChatPageDropIndicator(this, {
    sessionSplitAvailable: () => this.sessionSplitAvailable,
    narrow: () => this.narrow,
    applySessionDrop: (sessionKey, paneId, zone) => this.applySessionDrop(sessionKey, paneId, zone),
  });
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);
  private readonly viewerPresence = new ChatViewerPresenceController(this);
  private readonly retainedSessions = new ChatPageRetainedSessions(this, {
    context: () => this.context,
    presented: () => this.conversationPresented,
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
      .watchStore(
        () => this.context?.sessions,
        undefined,
        () => this.performUpdate(),
      )
      .watch(
        () => this.context?.chatSubmissions,
        (submissions, notify) => submissions.subscribeCreate(notify),
      )
      .watchStore(() => this.context?.placementStartup)
      .watchStore(() => this.context?.gateway)
      .watchStore(() => this.context?.nativeConversation);
    this.addController(
      new SessionPrefetchController(
        this,
        this.messageCache,
        this.snapshotStore,
        () => this.context,
      ),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.toggleAttribute("data-native-conversation", this.nativeConversation);
    this.snapshotStore.connect();
    observeChatCache(this.messageCache, this.snapshotStore);
    this.routeHref = window.location.href;
    this.layout = this.nativeConversation ? undefined : loadSettings().chatSplitLayout;
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
    this.sessionDrop.connect();
    window.addEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    this.retainedSessions.connect();
    this.syncRouteToActivePane();
    this.syncRouteBindings();
    const layout = this.layout ?? this.classicLayout();
    if (this.conversationPresented && !this.pendingCreate) {
      this.viewerPresence.sync(
        this.context?.gateway,
        layout,
        this.narrow,
        this.retainedSessions.unboundPaneIds,
      );
    }
  }

  override disconnectedCallback() {
    this.draftFocus.clearPendingDraft();
    this.closeFocus.clear();
    this.snapshotStore.disconnect();
    this.retainedSessions.disconnect();
    this.viewerPresence.dispose();
    this.mediaQuery?.removeEventListener("change", this.handleViewportChange);
    this.mediaQuery = null;
    this.mobileNavMediaQuery?.removeEventListener("change", this.handleMobileNavViewportChange);
    this.mobileNavMediaQuery = null;
    this.sessionDrop.disconnect();
    window.removeEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    // Cancelling retained previews republishes pane state; suspend only on a hiding edge.
    if (this.wasConversationPresented && !this.conversationPresented) {
      this.retainedSessions.suspend();
      this.sessionDrop.clear();
    }
    this.wasConversationPresented = this.conversationPresented;
    if (!this.conversationPresented || this.pendingCreate) {
      this.draftFocus.clearPendingDraft();
      this.closeFocus.clear();
      this.viewerPresence.dispose();
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
    const routeChanged = this.data !== this.processedRouteData;
    if (data && (routeChanged || changedProperties.has("presented"))) {
      this.draftFocus.clearPendingDraft();
      // Hidden native windows defer routing work; showing must consume the latest data.
      this.processedRouteData = this.data;
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
      if (routeChanged || !this.singleBoundPane) {
        this.syncRouteToActivePane();
      }
      this.syncRouteBindings();
      this.retainedSessions.settleRoute();
    }
    const draftPane = data && routeHandoffRendered ? this.routeDraftPane(data) : undefined;
    if (draftPane) {
      this.draftFocus.afterPaneUpdate(draftPane, () => {
        if (
          this.paneData === data &&
          this.consumedDraftData !== data &&
          this.routeDraftPane(data) === draftPane
        ) {
          this.draftFocus.beforeDraftCleanup(data);
          this.consumedDraftData = data;
          data.prepareNavigationHandoff?.();
          this.context.replace(data.face ?? "chat", locationWithoutDraft(currentRouteLocation()));
          this.requestUpdate();
        }
      });
    } else {
      this.draftFocus.clearPendingDraft();
    }
    const singlePane = this.singleBoundPane;
    const singleColumn = this.layout?.columns[0];
    if (
      singlePane &&
      singleColumn &&
      !this.mcpAppUnmountGate.retiring &&
      areUiSessionKeysEquivalent(singlePane.sessionKey, data?.sessionKey ?? "")
    ) {
      this.classicColumnId = singleColumn.id;
      this.classicPaneId = singlePane.id;
      this.persistLayout(undefined);
    }
  }

  private routeDraftPane(data: SessionChatRouteData) {
    if (
      !this.isConnected ||
      !this.conversationPresented ||
      this.pendingCreate ||
      this.mcpAppUnmountGate.retiring ||
      window.location.href !== this.routeHref
    ) {
      return undefined;
    }
    return this.retainedSessions.findActiveBoundPane(data.sessionKey);
  }

  private readonly handleViewportChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
    if (event.matches) {
      this.sessionDrop.clear();
    }
  };

  private resolveMergedChrome(mobileNavLayout: boolean): boolean {
    const webNavigation = mobileNavLayout && !this.nativeConversation;
    return mergeChatPageChrome(webNavigation, this.closest(".shell--onboarding") !== null);
  }

  private readonly handleMobileNavViewportChange = (event: MediaQueryListEvent) => {
    this.mergedChrome = this.resolveMergedChrome(event.matches);
  };

  private readonly handleUiCommand = (event: Event) => {
    if (!this.presented || this.pendingCreate || !(event instanceof CustomEvent)) {
      return;
    }
    // SAFETY: UI_COMMAND_EVENT comes from the validated Gateway adapter or typed local actions.
    const { command, sessionKey: sourceSessionKey, agentId } = event.detail as UiCommandDetail;
    if (
      command.kind !== "navigate" &&
      command.kind !== "split" &&
      command.kind !== "focus" &&
      command.kind !== "close-pane"
    ) {
      return;
    }
    const sessionKey = ownedChatPaneSessionKey(this.context, command.sessionKey, agentId);
    if (command.kind === "navigate") {
      event.preventDefault();
      if (this.layout && this.retainedSessions.unboundPaneIds.has(this.layout.activePaneId)) {
        this.adoptPaneNavigation(this.layout.activePaneId, sessionKey, agentId);
      }
      this.updateRoute(sessionKey, false, undefined, agentId);
      return;
    }
    if (command.kind === "split" && (this.narrow || this.nativeConversation)) {
      return;
    }

    const currentSessionKey = ownedChatPaneRouteData(this.context, this.data)?.sessionKey?.trim();
    const layout =
      this.layout ??
      (command.kind === "split" && currentSessionKey
        ? this.classicLayout(currentSessionKey)
        : undefined);
    if (!layout) {
      return;
    }
    if (command.kind === "close-pane") {
      const targetPane = panesOf(layout).find((pane) => pane.sessionKey === sessionKey);
      if (!targetPane) {
        return;
      }
      event.preventDefault();
      this.closeSplitPane(layout, targetPane.id);
      return;
    }
    const next = applyUiCommandToSplitLayout(
      layout,
      { ...command, sessionKey },
      sourceSessionKey
        ? ownedChatPaneSessionKey(this.context, sourceSessionKey, agentId)
        : undefined,
    );
    if (next === layout) {
      return;
    }
    event.preventDefault();
    this.persistLayout(next);
    const activePane = next && findPane(next, next.activePaneId)?.pane;
    if (activePane) {
      this.updateRouteToPane(activePane);
    }
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
    patchSettings({ chatSplitLayout: this.singleBoundPane ? undefined : layout });
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

  private readonly openSplitView = () => this.handleSplit(this.classicPaneId, "right");

  private handleSplit(paneId: string, direction: "right" | "down") {
    const layout =
      this.layout ??
      this.classicLayout(ownedChatPaneRouteData(this.context, this.data)?.sessionKey?.trim());
    const pane = findPane(layout, paneId)?.pane;
    if (!pane?.sessionKey) {
      return;
    }
    this.persistLayout(insertPane(layout, paneId, pane.sessionKey, direction));
  }

  private readonly handleSplitRight = (paneId: string) => this.handleSplit(paneId, "right");
  private readonly handleSplitDown = (paneId: string) => this.handleSplit(paneId, "down");

  private closeSplitPane(layout: ChatSplitLayout, paneId: string): void {
    if (this.singleBoundPane) {
      return;
    }
    const source = this.closeFocus.capture(paneId);
    const survivingPane = panesOf(layout).find((candidate) => candidate.id !== paneId);
    this.retainedSessions.discardPane(paneId);
    let next = closePane(layout, paneId, this.retainedSessions.unboundPaneIds);
    if (!next && survivingPane) {
      const survivingLocation = findPane(layout, survivingPane.id);
      if (survivingLocation) {
        this.classicColumnId = survivingLocation.column.id;
        this.classicPaneId = survivingPane.id;
        if (
          !areUiSessionKeysEquivalent(survivingPane.sessionKey, this.paneData?.sessionKey ?? "")
        ) {
          // Keep the survivor authoritative until route data leaves the closed pane.
          next = this.classicLayout(survivingPane.sessionKey);
        }
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
      activePaneId: splitMode && this.conversationPresented ? layout.activePaneId : undefined,
      renderPane: (column, pane, weight) =>
        renderChatPagePaneCell({
          active: this.conversationPresented && pane.id === layout.activePaneId,
          presented: this.conversationPresented,
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
          onOpenSplitView:
            splitMode || this.narrow || this.nativeConversation ? undefined : this.openSplitView,
          onPaneSessionChange: this.handlePaneSessionChange,
          onSessionDeleted: this.retainedSessions.removeSession,
          onSplitDown: splitMode ? this.handleSplitDown : undefined,
          onSplitRight: splitMode ? this.handleSplitRight : undefined,
          ownerKey: JSON.stringify([column.id, pane.id]),
          pane,
          panePosition: {
            column: layout.columns.indexOf(column) + 1,
            row: column.panes.indexOf(pane) + 1,
          },
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
        () => renderPendingChatPage(this.context, this.data.sessionKey, this.conversationPresented),
        () => [...this.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")],
      );
    }
    const layout = this.layout ?? this.classicLayout();
    const retainedSessions = this.retainedSessions.retain(panesOf(layout));
    const nextPaneKeys = chatPagePaneOwnerKeys(this.context, layout, retainedSessions);
    const renderValue = () =>
      renderChatPageBody(
        this.renderSplitLayout(
          layout,
          Boolean(this.layout && !this.singleBoundPane),
          retainedSessions,
        ),
        this.sessionDrop.indicator,
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
