import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
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
import { stillOwnsCanonicalLocation } from "./chat-canonical-location.ts";
import { ChatPageCloseFocus } from "./chat-page-close-focus.ts";
import { createChatPageDropIndicator } from "./chat-page-drop-indicator.ts";
import {
  navigateChatPage,
  ownedChatPaneRouteData,
  ownedChatPaneSessionKey,
  sameChatPaneRoute,
  subscribeChatPageRouteDefaults,
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
  const nativeConversation = nativeEmbedHost()?.surface === "conversation";
  // Resize-end and consecutive UI commands must read preceding mutations before Solid flushes.
  let splitLayout = nativeConversation ? undefined : loadSettings().chatSplitLayout;
  const mediaQuery = window.matchMedia("(max-width: 1099px)");
  const mobileNavMediaQuery = window.matchMedia(mobileNavLayoutMediaQuery());
  let narrow = mediaQuery.matches;
  let disposed = false;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let wasConversationPresented = false;
  let consumedDraftData: SessionChatRouteData | null = null;
  let classicColumnId = "c1";
  let classicPaneId = "p1";
  let routeHref = window.location.href;
  let unboundRoute: SessionChatRouteData | undefined;
  let processedRouteData: SessionChatRouteData | undefined;
  const draftFocus = new RouteDraftComposerFocus(host);
  const messageCache: ChatMessageCache = new Map();
  const snapshotStore = new SessionSnapshotStore(messageCache);
  const closeFocus = new ChatPageCloseFocus(host);
  const mcpAppUnmountGate = new McpAppUnmountGate<ChatPageSnapshot | null>({
    requestUpdate: invalidate,
  });
  const viewerPresence = createChatViewerPresence();
  const retainedSessions = new ChatPageRetainedSessions(host, {
    context,
    presented: conversationPresented,
    routeHref: () => routeHref,
    layout: () => splitLayout ?? classicLayout(),
    narrow: () => narrow,
    invalidate,
    selectReplacement: (paneId, sourceSessionKey, sessionKey) =>
      handlePaneSessionChange(paneId, sourceSessionKey, sessionKey),
    adoptNavigation: adoptPaneNavigation,
  });
  const sessionDrop = createChatPageDropIndicator(host, {
    sessionSplitAvailable,
    narrow: () => narrow,
    applySessionDrop,
  });
  const prefetch = untrack(() => createSessionPrefetch(host, messageCache, snapshotStore, context));

  function invalidate() {
    if (!disposed) {
      setRevision((value) => value + 1);
    }
  }

  function setLayout(next: ChatSplitLayout | undefined) {
    if (splitLayout !== next) {
      splitLayout = next;
      invalidate();
    }
  }

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
      !narrow &&
      !nativeConversation &&
      Boolean(props.data?.sessionKey?.trim())
    );
  }

  function paneData(): SessionChatRouteData {
    return splitLayout && !pendingCreate()
      ? ownedChatPaneRouteData(context(), props.data)
      : props.data;
  }

  function singleBoundPane(): ChatSplitPane | undefined {
    const panes = splitLayout ? panesOf(splitLayout) : [];
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
    const layout = splitLayout ?? classicLayout();
    resumeStagedPanes(host, layout, narrow);
    viewerPresence.sync(context().gateway, layout, narrow, retainedSessions.unboundPaneIds);
    closeFocus.restore(splitLayout, mcpAppUnmountGate.retiring);
    const data = paneData();
    const activePane = splitLayout ? findPane(splitLayout, splitLayout.activePaneId)?.pane : null;
    const activeSessionKey = splitLayout ? (activePane?.sessionKey ?? null) : undefined;
    const routeHandoffRendered = draftFocus.rendered(data, activeSessionKey, consumedDraftData);
    const routeChanged = props.data !== processedRouteData;
    if (data && (routeChanged || presentationChanged)) {
      // Hidden native windows defer routing work; showing must consume the latest data.
      processedRouteData = props.data;
      routeHref = window.location.href;
      if (
        data?.canonicalLocation &&
        stillOwnsCanonicalLocation(data.canonicalLocationSource, consumedDraftData === data)
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
          stillOwnsCanonicalLocation(data.canonicalLocationSource, consumedDraftData === data)
        ) {
          // A lazy canonicalization must never replace a newer route.
          context().replace(
            data.face ?? "chat",
            consumedDraftData === data ? locationWithoutDraft(location) : location,
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
            consumedDraftData !== data
          ) {
            draftFocus.beforeDraftCleanup(data);
            consumedDraftData = data;
            updateRoute(data.sessionKey, true, data.face ?? "chat");
            invalidate();
          }
        });
      }
    }
    const singlePane = singleBoundPane();
    const singleColumn = splitLayout?.columns[0];
    if (
      singlePane &&
      singleColumn &&
      !mcpAppUnmountGate.retiring &&
      areUiSessionKeysEquivalent(singlePane.sessionKey, data?.sessionKey ?? "")
    ) {
      classicColumnId = singleColumn.id;
      classicPaneId = singlePane.id;
      persistLayout(undefined);
    }
  }

  const handleViewportChange = (event: MediaQueryListEvent) => {
    if (narrow !== event.matches) {
      narrow = event.matches;
      invalidate();
    }
    if (event.matches) {
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
      if (splitLayout && retainedSessions.unboundPaneIds.has(splitLayout.activePaneId)) {
        adoptPaneNavigation(splitLayout.activePaneId, sessionKey, agentId);
      }
      updateRoute(sessionKey, false, undefined, agentId);
      return;
    }
    if (command.kind === "split" && (narrow || nativeConversation)) {
      return;
    }

    const currentSessionKey = ownedChatPaneRouteData(context(), props.data)?.sessionKey?.trim();
    const layout =
      splitLayout ??
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
    const layout = splitLayout;
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
    const activePane = splitLayout && findPane(splitLayout, splitLayout.activePaneId)?.pane;
    const routeKey = (activePane?.sessionKey ?? props.data?.sessionKey)?.trim();
    if (routeKey && (!activePane || !retainedSessions.unboundPaneIds.has(activePane.id))) {
      bindChatPageSession(context(), routeKey, agentId);
    }
  }

  function adoptPaneNavigation(paneId: string, sessionKey: string, agentId?: string): void {
    if (!splitLayout || (isUiGlobalSessionKey(sessionKey) && !agentId?.trim())) {
      return;
    }
    retainedSessions.bindPane(paneId);
    unboundRoute = undefined;
    persistLayout(
      setPaneSession(splitLayout, paneId, ownedChatPaneSessionKey(context(), sessionKey, agentId)),
      agentId,
    );
  }

  function persistLayout(layout: ChatSplitLayout | undefined, agentId?: string) {
    setLayout(layout);
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
    if (!splitLayout && zone.kind === "center") {
      updateRoute(trimmed);
      return;
    }
    // A classic edge drop starts a split; both modes then use the same layout operation.
    const layout =
      splitLayout ?? classicLayout(ownedChatPaneRouteData(context(), props.data)?.sessionKey);
    const targetPaneId = splitLayout ? paneId : classicPaneId;
    const pane = findPane(layout, targetPaneId)?.pane;
    if (!pane || (!splitLayout && !pane.sessionKey)) {
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
    const layout = splitLayout;
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
    const resolvedLayout = splitLayout ?? classicLayout();
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
    if (!splitLayout) {
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
    const selectedSessionKey = findPane(splitLayout ?? classicLayout(), paneId)?.pane.sessionKey;
    if (!selectedSessionKey || !areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      return;
    }
    if (
      (!splitLayout || splitLayout.activePaneId === paneId) &&
      areUiSessionKeysEquivalent(props.data.sessionKey, sessionKey) &&
      (props.data.face ?? "chat") === face
    ) {
      // Applying a dashboard default also announces its face. Keep the current
      // route intent; only explicit pane focus should supersede pending navigation.
      syncRouteBindings();
      return;
    }
    if (splitLayout && splitLayout.activePaneId !== paneId) {
      persistLayout(setActivePane(splitLayout, paneId));
    }
    updateRoute(sessionKey, false, face);
  };

  const openSplitView = () => handleSplit(classicPaneId, "right");

  function handleSplit(paneId: string, direction: "right" | "down") {
    const layout =
      splitLayout ??
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
        classicColumnId = survivingLocation.column.id;
        classicPaneId = survivingPane.id;
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
    if (splitLayout) {
      closeSplitPane(splitLayout, paneId);
    }
  };

  function classicLayout(sessionKey = props.data?.sessionKey?.trim() ?? ""): ChatSplitLayout {
    return singlePaneLayout(classicColumnId, classicPaneId, sessionKey);
  }

  function createSnapshot(
    layout: ChatSplitLayout,
    splitMode: boolean,
    retainedSessionKeys: ReadonlyMap<string, readonly (string | undefined)[]>,
  ) {
    const onboarding = host.closest(".shell--onboarding") !== null;
    const webNavigation = mobileNavMediaQuery.matches && !nativeConversation;
    return createChatPageSnapshot(layout, {
      retainedSessions: retainedSessionKeys,
      unboundPaneIds: pendingCreate() ? undefined : retainedSessions.unboundPaneIds,
      pane: {
        presented: conversationPresented(),
        chatMessagesBySession: messageCache,
        sessionSnapshotStore: snapshotStore,
        consumedDraftData,
        context: context(),
        data: paneData(),
        draftFocus,
        mergedChrome: mergeChatPageChrome(webNavigation, onboarding),
        narrow,
        navDrawerOpen: props.navDrawerOpen,
        onboarding,
        onClosePane: splitMode ? handleClosePane : undefined,
        onFaceChange: handlePaneFaceChange,
        onFocusPane: handleFocusPane,
        onOpenSplitView: splitMode || narrow || nativeConversation ? undefined : openSplitView,
        onPaneSessionChange: handlePaneSessionChange,
        onSessionDeleted: retainedSessions.removeSession,
        onSplitDown: splitMode ? handleSplitDown : undefined,
        onSplitRight: splitMode ? handleSplitRight : undefined,
        splitMode,
      },
      onResizePanes: (columnId, paneIndex, ratio) => {
        setLayout(splitLayout ? resizePanes(splitLayout, columnId, paneIndex, ratio) : undefined);
      },
      onResizeColumns: (columnIndex, ratio) => {
        setLayout(splitLayout ? resizeColumns(splitLayout, columnIndex, ratio) : undefined);
      },
      onResizeEnd: () => persistLayout(splitLayout),
    });
  }

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
    const layout = splitLayout ?? classicLayout();
    const retained = retainedSessions.retain(panesOf(layout));
    const nextPaneKeys = chatPagePaneOwnerKeys(context(), layout, retained);
    const renderValue = () =>
      createSnapshot(layout, Boolean(splitLayout && !singleBoundPane()), retained);
    return mcpAppUnmountGate.render(JSON.stringify([...nextPaneKeys]), renderValue, () =>
      [...host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].filter(
        (pane) => !nextPaneKeys.has(pane.dataset.mcpAppOwnerKey ?? ""),
      ),
    );
  }
  createEffect(createMemo(context), (source) => {
    const subscriptions = [
      source.chatSubmissions?.subscribeCreate(invalidate),
      source.placementStartup?.subscribe(invalidate),
      subscribeChatPageRouteDefaults(source.gateway, invalidate),
      source.nativeConversation?.subscribe(invalidate),
    ];
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe?.();
      }
    };
  });
  // Boot consumes the current route once; the snapshot memo tracks later prop changes.
  untrack(() => {
    host.toggleAttribute("data-native-conversation", nativeConversation);
    snapshotStore.connect();
    observeChatCache(messageCache, snapshotStore);
    retainedSessions.restore(splitLayout ? panesOf(splitLayout) : []);
    unboundRoute =
      splitLayout && retainedSessions.unboundPaneIds.has(splitLayout.activePaneId)
        ? paneData()
        : undefined;
    mediaQuery.addEventListener("change", handleViewportChange);
    mobileNavMediaQuery.addEventListener("change", invalidate);
    window.addEventListener(UI_COMMAND_EVENT, handleUiCommand);
    retainedSessions.connect();
    syncRouteToActivePane();
    syncRouteBindings();
    if (conversationPresented() && !pendingCreate()) {
      viewerPresence.sync(
        context().gateway,
        splitLayout ?? classicLayout(),
        narrow,
        retainedSessions.unboundPaneIds,
      );
    }
  });
  const snapshot = createMemo(() => {
    revision();
    return render();
  });
  // Direct Solid construction precedes attachment; shell ancestry is available after settlement.
  onSettled(invalidate);
  let lastPresented = untrack(() => props.presented);
  createEffect(
    () => ({ revision: revision(), frame: snapshot(), presented: props.presented }),
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
    mediaQuery.removeEventListener("change", handleViewportChange);
    mobileNavMediaQuery.removeEventListener("change", invalidate);
    window.removeEventListener(UI_COMMAND_EVENT, handleUiCommand);
  });
  return { snapshot, sessionSplitAvailable, sessionDrop };
}
