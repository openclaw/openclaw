import { createEffect, createMemo, onCleanup, onSettled, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { mergeChatPageChrome, mobileNavLayoutMediaQuery } from "../../app/mobile-nav-layout.ts";
import { nativeEmbedHost } from "../../app/native-web-chrome.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { createMcpAppUnmountGate } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import { stillOwnsCanonicalLocation } from "./chat-canonical-location.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { ChatPageCloseFocus } from "./chat-page-close-focus.ts";
import { createChatPageDropIndicator } from "./chat-page-drop-indicator.ts";
import {
  navigateChatPage,
  ownedChatPaneRouteData,
  ownedChatPaneSessionKey,
  sameChatPaneRoute,
} from "./chat-page-navigation.ts";
import {
  type ChatPageSnapshot,
  chatPagePaneOwnerKeys,
  createChatPageSnapshot,
} from "./chat-page-pane-render.tsx";
import { ChatPageRetainedSessions } from "./chat-page-retained-sessions.ts";
import type { ChatPageHost, ChatPageProps } from "./chat-page-types.ts";
import { resumeStagedPanes } from "./chat-pane-attachment-handoff.ts";
import { bindChatPageSession } from "./chat-state-route.ts";
import { createChatViewerPresence } from "./chat-viewer-presence.ts";
import { RouteDraftComposerFocus, type ChatPaneElement } from "./route-draft-focus-handoff.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import { createSessionPrefetch } from "./session-prefetch.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";
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
export function createChatPageState(
  host: ChatPageHost,
  props: ChatPageProps,
  application: ApplicationContext,
) {
  const context = () => props.context ?? application;
  const presentationSources = createMemo(() => {
    const source = context();
    return [
      projectOwner(source.gateway, (gateway) => gateway.snapshot.hello, Object.is),
      projectOwner(source.placementStartup, (startup) => startup),
      projectSource(source.chatSubmissions, {
        read: (owner) => owner.creation,
        subscribe: (owner, notify) => owner.subscribeCreate(notify),
        equality: "revision",
      }),
      ...(source.nativeConversation
        ? [projectOwner(source.nativeConversation, (native) => native.presentation)]
        : []),
    ];
  });
  const nativeConversation = nativeEmbedHost()?.surface === "conversation";
  const mediaQuery = window.matchMedia("(max-width: 1099px)");
  const mobileNavMediaQuery = window.matchMedia(mobileNavLayoutMediaQuery());
  // Commands read the synchronous values; each field publishes only its own changes.
  const state: {
    splitLayout: ChatSplitLayout | undefined;
    narrow: boolean;
    webNavigation: boolean;
    mounted: boolean;
    consumedDraftData: SessionChatRouteData | null;
    classicColumnId: string;
    classicPaneId: string;
  } = projectChatFields({
    splitLayout: nativeConversation ? undefined : loadSettings().chatSplitLayout,
    narrow: mediaQuery.matches,
    webNavigation: mobileNavMediaQuery.matches && !nativeConversation,
    mounted: host.isConnected,
    consumedDraftData: null,
    classicColumnId: "c1",
    classicPaneId: "p1",
  });
  let disposed = false;
  let wasConversationPresented = false;
  let routeHref = window.location.href;
  let unboundRoute: SessionChatRouteData | undefined;
  let processedRouteData: SessionChatRouteData | undefined;
  const draftFocus = new RouteDraftComposerFocus(host);
  const messageCache: ChatMessageCache = new Map();
  const snapshotStore = new SessionSnapshotStore(messageCache);
  const closeFocus = new ChatPageCloseFocus(host);
  const mcpAppUnmountGate = createMcpAppUnmountGate<ChatPageSnapshot | null>();
  const mcpRetirement = projectOwner(mcpAppUnmountGate, (gate) => gate.retiring);
  const viewerPresence = createChatViewerPresence();
  const retainedSessions = new ChatPageRetainedSessions(host, {
    context,
    presented: conversationPresented,
    routeHref: () => routeHref,
    layout: () => state.splitLayout ?? classicLayout(),
    narrow: () => state.narrow,
    selectReplacement: (paneId, sourceSessionKey, sessionKey) =>
      handlePaneSessionChange(paneId, sourceSessionKey, sessionKey),
    adoptNavigation: adoptPaneNavigation,
  });
  const retention = projectOwner(retainedSessions, (owner) => owner);
  const sessionDrop = createChatPageDropIndicator(host, {
    sessionSplitAvailable,
    narrow: () => state.narrow,
    applySessionDrop,
  });
  // Prefetch lives with the page and reads replacement contexts through the accessor.
  const prefetch = untrack(() => createSessionPrefetch(host, messageCache, snapshotStore, context));

  function conversationPresented(): boolean {
    const presentation = context().nativeConversation?.presentation;
    return props.presented && (!presentation || presentation.visible);
  }

  function pendingCreate(): boolean {
    return props.data?.creation?.admitted === false;
  }

  function sessionSplitAvailable(): boolean {
    return (
      props.presented &&
      !pendingCreate() &&
      !state.narrow &&
      !nativeConversation &&
      Boolean(props.data?.sessionKey?.trim())
    );
  }

  function paneData(): SessionChatRouteData {
    return state.splitLayout && !pendingCreate()
      ? ownedChatPaneRouteData(context(), props.data)
      : props.data;
  }

  function singleBoundPane(): ChatSplitPane | undefined {
    const panes = state.splitLayout ? panesOf(state.splitLayout) : [];
    const pane = panes.length === 1 ? panes[0] : undefined;
    return pane && !retainedSessions.unboundPaneIds.has(pane.id) ? pane : undefined;
  }

  function updated(presentationChanged: boolean, renderedSnapshot: ChatPageSnapshot | null) {
    prefetch();
    // Cancelling retained previews republishes pane state; suspend only on a hiding edge.
    if (wasConversationPresented && !conversationPresented()) {
      retainedSessions.suspend();
      sessionDrop.clear();
    }
    wasConversationPresented = conversationPresented();
    if (!conversationPresented() || pendingCreate()) {
      closeFocus.clear();
      viewerPresence.clear();
      return;
    }
    const layout = state.splitLayout ?? classicLayout();
    resumeStagedPanes(host, layout, state.narrow);
    viewerPresence.sync(context().gateway, layout, state.narrow, retainedSessions.unboundPaneIds);
    closeFocus.restore(state.splitLayout, mcpAppUnmountGate.retiring);
    const data = paneData();
    const activePane = state.splitLayout
      ? findPane(state.splitLayout, state.splitLayout.activePaneId)?.pane
      : null;
    const activeSessionKey = state.splitLayout ? (activePane?.sessionKey ?? null) : undefined;
    const routeHandoffRendered = draftFocus.rendered(
      data,
      activeSessionKey,
      state.consumedDraftData,
    );
    const routeChanged = props.data !== processedRouteData;
    if (data && (routeChanged || presentationChanged)) {
      // Hidden native windows defer routing work; showing must consume the latest data.
      processedRouteData = props.data;
      routeHref = window.location.href;
      if (
        data?.canonicalLocation &&
        stillOwnsCanonicalLocation(data.canonicalLocationSource, state.consumedDraftData === data)
      ) {
        // Move a route matched under the wrong namespace to its resolved board face.
        context().replace(data.face ?? "chat", data.canonicalLocation);
        return;
      }
      void data?.canonicalLocationReady?.then((location) => {
        if (
          location &&
          !disposed &&
          props.presented &&
          paneData() === data &&
          stillOwnsCanonicalLocation(data.canonicalLocationSource, state.consumedDraftData === data)
        ) {
          // A lazy canonicalization must never replace a newer route.
          context().replace(
            data.face ?? "chat",
            state.consumedDraftData === data ? locationWithoutDraft(location) : location,
          );
        }
      });
      if (routeChanged || !singleBoundPane()) {
        syncRouteToActivePane();
      }
      syncRouteBindings();
      retainedSessions.settleRoute();
    }
    // A route publication can be newer than the rendered frame.
    if (data && routeHandoffRendered && renderedSnapshot?.options.pane.data === data) {
      const pane = retainedSessions.findPane(renderedSnapshot.layout.activePaneId, data.sessionKey);
      const draftRouteHref = routeHref;
      if (pane) {
        // The page frame can commit before the pane has applied its route draft.
        void Promise.resolve(pane.updateComplete).then(() => {
          if (
            !disposed &&
            conversationPresented() &&
            window.location.href === draftRouteHref &&
            paneData() === data &&
            state.consumedDraftData !== data
          ) {
            draftFocus.beforeDraftCleanup(data);
            state.consumedDraftData = data;
            updateRoute(data.sessionKey, true, data.face ?? "chat");
          }
        });
      }
    }
    const singlePane = singleBoundPane();
    const singleColumn = state.splitLayout?.columns[0];
    if (
      singlePane &&
      singleColumn &&
      !mcpAppUnmountGate.retiring &&
      areUiSessionKeysEquivalent(singlePane.sessionKey, data?.sessionKey ?? "")
    ) {
      state.classicColumnId = singleColumn.id;
      state.classicPaneId = singlePane.id;
      persistLayout(undefined);
    }
  }

  const handleViewportChange = () => {
    state.narrow = mediaQuery.matches;
    state.webNavigation = mobileNavMediaQuery.matches && !nativeConversation;
    if (mediaQuery.matches) {
      sessionDrop.clear();
    }
  };

  const handleUiCommand = (event: Event) => {
    if (!props.presented || pendingCreate() || !(event instanceof CustomEvent)) {
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
    const sessionKey = ownedChatPaneSessionKey(context(), command.sessionKey, agentId);
    if (command.kind === "navigate") {
      event.preventDefault();
      if (
        state.splitLayout &&
        retainedSessions.unboundPaneIds.has(state.splitLayout.activePaneId)
      ) {
        adoptPaneNavigation(state.splitLayout.activePaneId, sessionKey, agentId);
      }
      updateRoute(sessionKey, false, undefined, agentId);
      return;
    }
    if (command.kind === "split" && (state.narrow || nativeConversation)) {
      return;
    }

    const currentSessionKey = ownedChatPaneRouteData(context(), props.data)?.sessionKey?.trim();
    const layout =
      state.splitLayout ??
      (command.kind === "split" && currentSessionKey
        ? classicLayout(currentSessionKey)
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
      closeSplitPane(layout, targetPane.id);
      return;
    }
    const next = applyUiCommandToSplitLayout(
      layout,
      { ...command, sessionKey },
      sourceSessionKey ? ownedChatPaneSessionKey(context(), sourceSessionKey, agentId) : undefined,
    );
    if (next === layout) {
      return;
    }
    event.preventDefault();
    persistLayout(next);
    const activePane = next && findPane(next, next.activePaneId)?.pane;
    if (activePane) {
      updateRouteToPane(activePane);
    }
  };

  function syncRouteToActivePane() {
    const layout = state.splitLayout;
    const sessionKey = paneData()?.sessionKey?.trim();
    if (!layout || !sessionKey || pendingCreate()) {
      return;
    }
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (!activePane || activePane.sessionKey === sessionKey) {
      return;
    }
    // A refresh of the old route is not a conversation choice for an unbound pane.
    if (
      retainedSessions.unboundPaneIds.has(activePane.id) &&
      retainedSessions.wasPendingAtFocus()
    ) {
      unboundRoute = paneData();
    }
    if (
      retainedSessions.unboundPaneIds.has(activePane.id) &&
      sameChatPaneRoute(context(), unboundRoute, paneData())
    ) {
      return;
    }
    retainedSessions.bindPane(activePane.id);
    persistLayout(setPaneSession(layout, activePane.id, sessionKey));
  }

  function syncRouteBindings(agentId = props.data?.agentId) {
    if (!props.presented || pendingCreate()) {
      return;
    }
    const activePane =
      state.splitLayout && findPane(state.splitLayout, state.splitLayout.activePaneId)?.pane;
    const routeKey = (activePane?.sessionKey ?? props.data?.sessionKey)?.trim();
    if (routeKey && (!activePane || !retainedSessions.unboundPaneIds.has(activePane.id))) {
      bindChatPageSession(context(), routeKey, agentId);
    }
  }

  function adoptPaneNavigation(paneId: string, sessionKey: string, agentId?: string): void {
    if (!state.splitLayout || (isUiGlobalSessionKey(sessionKey) && !agentId?.trim())) {
      return;
    }
    retainedSessions.bindPane(paneId);
    unboundRoute = undefined;
    persistLayout(
      setPaneSession(
        state.splitLayout,
        paneId,
        ownedChatPaneSessionKey(context(), sessionKey, agentId),
      ),
      agentId,
    );
  }

  function persistLayout(layout: ChatSplitLayout | undefined, agentId?: string) {
    state.splitLayout = layout;
    patchSettings({ chatSplitLayout: singleBoundPane() ? undefined : layout });
    syncRouteBindings(agentId);
  }

  function updateRoute(
    sessionKey: string,
    replace = false,
    explicitFace?: BoardFace,
    agentId?: string,
  ) {
    if (props.presented) {
      navigateChatPage(context(), props.data, sessionKey, replace, explicitFace, agentId);
    }
  }

  function updateRouteToPane(pane: ChatSplitPane): void {
    if (retainedSessions.unboundPaneIds.has(pane.id)) {
      retainedSessions.capturePendingNavigation();
      unboundRoute = paneData();
      return;
    }
    unboundRoute = undefined;
    const mounted = retainedSessions.findPane(pane.id, pane.sessionKey);
    updateRoute(pane.sessionKey, true, mounted?.captureNavigationFace?.());
  }

  function applySessionDrop(sessionKey: string, paneId: string, zone: SplitDropZone): void {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return;
    }
    if (!state.splitLayout && zone.kind === "center") {
      updateRoute(trimmed);
      return;
    }
    // A classic edge drop starts a split; both modes then use the same layout operation.
    const layout =
      state.splitLayout ?? classicLayout(ownedChatPaneRouteData(context(), props.data)?.sessionKey);
    const targetPaneId = state.splitLayout ? paneId : state.classicPaneId;
    const pane = findPane(layout, targetPaneId)?.pane;
    if (!pane || (!state.splitLayout && !pane.sessionKey)) {
      return;
    }
    if (zone.kind === "center" && pane.sessionKey === trimmed) {
      return;
    }
    persistLayout(
      zone.kind === "center"
        ? setPaneSession(setActivePane(layout, targetPaneId), targetPaneId, trimmed)
        : insertPane(layout, targetPaneId, trimmed, zone.edge),
    );
    updateRoute(trimmed, true);
  }

  const handleFocusPane = (paneId: string, intent?: "review-edit") => {
    const layout = state.splitLayout;
    // Provisional p1 is presentation, not a focus change in the saved split.
    const canFocus = !pendingCreate() && (props.presented || intent === "review-edit");
    if (!canFocus || !layout || layout.activePaneId === paneId) {
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane) {
      return;
    }
    persistLayout(setActivePane(layout, paneId));
    updateRouteToPane(pane);
  };

  const handlePaneSessionChange = (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ): boolean => {
    let trimmed = sessionKey.trim();
    if (!props.presented || !trimmed || window.location.href !== routeHref) {
      return false;
    }
    const resolvedLayout = state.splitLayout ?? classicLayout();
    const pane = findPane(resolvedLayout, paneId)?.pane;
    if (!pane || !areUiSessionKeysEquivalent(pane.sessionKey, sourceSessionKey)) {
      return false;
    }
    // Canonical wire spelling must not erase a bound pane's Home owner.
    if (
      isUiGlobalSessionKey(trimmed) &&
      resolveUiGlobalAliasAgentId(
        {
          agentsList: context().agents.state.agentsList,
          hello: context().gateway.snapshot.hello,
        },
        pane.sessionKey,
      )
    ) {
      trimmed = pane.sessionKey;
    }
    if (!state.splitLayout) {
      if (areUiSessionKeysEquivalent(pane.sessionKey, trimmed)) {
        syncRouteBindings();
        return true;
      }
      updateRoute(trimmed, options?.replace);
      return true;
    }
    if (pane.sessionKey === trimmed) {
      return true;
    }
    persistLayout(setPaneSession(resolvedLayout, paneId, trimmed));
    if (resolvedLayout.activePaneId === paneId) {
      updateRoute(trimmed, options?.replace);
    }
    return true;
  };

  const handlePaneFaceChange = (paneId: string, sessionKey: string, face: BoardFace): void => {
    if (!props.presented) {
      return;
    }
    const selectedSessionKey = findPane(state.splitLayout ?? classicLayout(), paneId)?.pane
      .sessionKey;
    if (!selectedSessionKey || !areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      return;
    }
    if (
      (!state.splitLayout || state.splitLayout.activePaneId === paneId) &&
      areUiSessionKeysEquivalent(props.data.sessionKey, sessionKey) &&
      (props.data.face ?? "chat") === face
    ) {
      // Applying a dashboard default also announces its face. Keep the current
      // route intent; only explicit pane focus should supersede pending navigation.
      syncRouteBindings();
      return;
    }
    if (state.splitLayout && state.splitLayout.activePaneId !== paneId) {
      persistLayout(setActivePane(state.splitLayout, paneId));
    }
    updateRoute(sessionKey, false, face);
  };

  const openSplitView = () => handleSplit(state.classicPaneId, "right");

  function handleSplit(paneId: string, direction: "right" | "down") {
    const layout =
      state.splitLayout ??
      classicLayout(ownedChatPaneRouteData(context(), props.data)?.sessionKey?.trim());
    const pane = findPane(layout, paneId)?.pane;
    if (!pane?.sessionKey) {
      return;
    }
    persistLayout(insertPane(layout, paneId, pane.sessionKey, direction));
  }

  const handleSplitRight = (paneId: string) => handleSplit(paneId, "right");
  const handleSplitDown = (paneId: string) => handleSplit(paneId, "down");

  function closeSplitPane(layout: ChatSplitLayout, paneId: string): void {
    if (singleBoundPane()) {
      return;
    }
    const source = closeFocus.capture(paneId);
    const survivingPane = panesOf(layout).find((candidate) => candidate.id !== paneId);
    retainedSessions.discardPane(paneId);
    let next = closePane(layout, paneId, retainedSessions.unboundPaneIds);
    if (!next && survivingPane) {
      const survivingLocation = findPane(layout, survivingPane.id);
      if (survivingLocation) {
        state.classicColumnId = survivingLocation.column.id;
        state.classicPaneId = survivingPane.id;
        if (!areUiSessionKeysEquivalent(survivingPane.sessionKey, paneData()?.sessionKey ?? "")) {
          // Keep the survivor authoritative until route data leaves the closed pane.
          next = classicLayout(survivingPane.sessionKey);
        }
      }
    }
    persistLayout(next);
    const activePane = next ? findPane(next, next.activePaneId)?.pane : survivingPane;
    if (activePane) {
      updateRouteToPane(activePane);
      if (source) {
        closeFocus.schedule(source, activePane, next);
      }
    }
  }

  const handleClosePane = (paneId: string) => {
    if (state.splitLayout) {
      closeSplitPane(state.splitLayout, paneId);
    }
  };

  function classicLayout(sessionKey = props.data?.sessionKey?.trim() ?? ""): ChatSplitLayout {
    return singlePaneLayout(state.classicColumnId, state.classicPaneId, sessionKey);
  }

  function createSnapshot(
    layout: ChatSplitLayout,
    splitMode: boolean,
    retainedSessionKeys: ReadonlyMap<string, readonly (string | undefined)[]>,
  ) {
    const onboarding = state.mounted && host.closest(".shell--onboarding") !== null;
    return createChatPageSnapshot(layout, {
      retainedSessions: retainedSessionKeys,
      unboundPaneIds: pendingCreate() ? undefined : retainedSessions.unboundPaneIds,
      pane: {
        presented: conversationPresented(),
        chatMessagesBySession: messageCache,
        sessionSnapshotStore: snapshotStore,
        consumedDraftData: state.consumedDraftData,
        context: context(),
        data: paneData(),
        draftFocus,
        mergedChrome: mergeChatPageChrome(state.webNavigation, onboarding),
        narrow: state.narrow,
        navDrawerOpen: props.navDrawerOpen,
        gatewayStatus: props.gatewayStatus,
        onboarding,
        onClosePane: splitMode ? handleClosePane : undefined,
        onFaceChange: handlePaneFaceChange,
        onFocusPane: handleFocusPane,
        onOpenSplitView:
          splitMode || state.narrow || nativeConversation ? undefined : openSplitView,
        onPaneSessionChange: handlePaneSessionChange,
        onSessionDeleted: retainedSessions.removeSession,
        onSplitDown: splitMode ? handleSplitDown : undefined,
        onSplitRight: splitMode ? handleSplitRight : undefined,
        splitMode,
      },
      onResizePanes: (columnId, paneIndex, ratio) => {
        state.splitLayout = state.splitLayout
          ? resizePanes(state.splitLayout, columnId, paneIndex, ratio)
          : undefined;
      },
      onResizeColumns: (columnIndex, ratio) => {
        state.splitLayout = state.splitLayout
          ? resizeColumns(state.splitLayout, columnIndex, ratio)
          : undefined;
      },
      onResizeEnd: () => persistLayout(state.splitLayout),
    });
  }

  // MCP teardown discovers retained native pane hosts across their component boundary.
  function render() {
    if (pendingCreate()) {
      return mcpAppUnmountGate.render(
        "pending-create",
        () => {
          if (!conversationPresented()) {
            return null;
          }
          const layout = classicLayout();
          return createSnapshot(
            layout,
            false,
            new Map([[layout.activePaneId, [props.data.sessionKey]]]),
          );
        },
        () => [...host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")],
      );
    }
    const layout = state.splitLayout ?? classicLayout();
    const retained = retention.read().retain(panesOf(layout));
    const nextPaneKeys = chatPagePaneOwnerKeys(context(), layout, retained);
    const renderValue = () =>
      createSnapshot(layout, Boolean(state.splitLayout && !singleBoundPane()), retained);
    return mcpAppUnmountGate.render(JSON.stringify([...nextPaneKeys]), renderValue, () =>
      [...host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].filter(
        (pane) => !nextPaneKeys.has(pane.dataset.mcpAppOwnerKey ?? ""),
      ),
    );
  }
  // Boot consumes the current route once; the snapshot memo tracks later prop changes.
  untrack(() => {
    host.toggleAttribute("data-native-conversation", nativeConversation);
    snapshotStore.connect();
    observeChatCache(messageCache, snapshotStore);
    retainedSessions.restore(state.splitLayout ? panesOf(state.splitLayout) : []);
    unboundRoute =
      state.splitLayout && retainedSessions.unboundPaneIds.has(state.splitLayout.activePaneId)
        ? paneData()
        : undefined;
    onCleanup(listen(mediaQuery, "change", handleViewportChange));
    onCleanup(listen(mobileNavMediaQuery, "change", handleViewportChange));
    onCleanup(listen(window, UI_COMMAND_EVENT, handleUiCommand));
    retainedSessions.connect();
    syncRouteToActivePane();
    syncRouteBindings();
    if (conversationPresented() && !pendingCreate()) {
      viewerPresence.sync(
        context().gateway,
        state.splitLayout ?? classicLayout(),
        state.narrow,
        retainedSessions.unboundPaneIds,
      );
    }
  });
  const snapshot = createMemo(() => {
    mcpRetirement.read();
    presentationSources().forEach((source) => source.read());
    return render();
  });
  // Direct Solid construction precedes attachment; shell ancestry is available after settlement.
  onSettled(() => {
    state.mounted = host.isConnected;
  });
  // Compare against the last committed presentation, including superseded queued frames.
  let lastPresented = untrack(() => props.presented);
  // Presence follows layout changes even while MCP teardown retains the previous DOM frame.
  // Route focus still waits for the committed pane DOM.
  createEffect(
    () => ({
      frame: snapshot(),
      presented: props.presented,
      layout: state.splitLayout,
      narrow: state.narrow,
    }),
    (next) => {
      let current = true;
      // Pane effects must commit before route focus is consumed; only the latest frame applies.
      queueMicrotask(() => {
        if (!current || disposed) {
          return;
        }
        const changed = lastPresented !== next.presented;
        lastPresented = next.presented;
        updated(changed, next.frame);
      });
      return () => {
        current = false;
      };
    },
  );
  onCleanup(() => {
    disposed = true;
    closeFocus.clear();
    snapshotStore.disconnect();
    retainedSessions.disconnect();
  });
  return { snapshot, sessionSplitAvailable, sessionDrop };
}
