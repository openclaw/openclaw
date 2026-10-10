import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { DEFAULT_SIDEBAR_ENTRIES, serializeSidebarEntry } from "../app-navigation.ts";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { patchSettings } from "../app/settings.ts";
import { isUpdateActionable } from "../app/update-schedule-projection.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { categoryClearReturnsToGroups } from "../lib/sessions/grouping.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import {
  canCopySessionMarkdown,
  canSplitSessionView,
  runSessionNavigationAction,
} from "../lib/sessions/session-menu-navigation.ts";
import { showToast } from "../lib/toast.ts";
import {
  pluginSessionMenuActions,
  runControlUiPluginAction,
} from "../plugins/control-ui-actions.ts";
import { renderSidebarAgentMenu } from "./app-sidebar-agent-menu.tsx";
import { renderSidebarIdentityMenu } from "./app-sidebar-identity-menu.tsx";
import { renderSidebarCustomizeMenu, renderSidebarMoreMenu } from "./app-sidebar-nav-menus.tsx";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import { canRetryGatewayStatus } from "./gateway-status.ts";
import "../styles/sidebar-menus.css";
import { sessionMenuReasons } from "./session-menu-access.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import {
  isSidebarAttentionDismissed,
  isUpdateAttentionForced,
  loadDismissals,
  resolveSidebarAttentionKey,
  resolveUpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";

export { focusActiveAgentMenuItem } from "./app-sidebar-agent-menu.tsx";
export {
  renderSidebarCatalogViewMenuForController,
  renderSidebarSessionGroupMenuForController,
  renderSidebarSessionSortMenuForController,
} from "./app-sidebar-session-menu-renderers.tsx";
export { renderSidebarPluginNavigationMenuForController } from "./app-sidebar-plugin-navigation-menu.tsx";
export { renderSidebarPeopleFilterMenuForController } from "./app-sidebar-people-filter-menu.tsx";

export function renderSidebarCustomizeMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.customizeMenuPosition;
  if (!position) {
    return undefined;
  }
  const toggleEntry = (entry: string) => {
    const canonical = host.reconciledSidebarZone().sidebarEntries;
    host.onUpdateSidebarEntries?.(
      canonical.includes(entry)
        ? canonical.filter((candidate) => candidate !== entry)
        : [...canonical, entry],
    );
  };
  return renderSidebarCustomizeMenu({
    get position() {
      return position;
    },
    get sidebarEntries() {
      return host.sidebarEntries;
    },
    get preferencesBrowserOnly() {
      return host.preferencesBrowserOnly;
    },
    isRouteEnabled: (routeId) => controller.isRouteEnabled(routeId),
    get pluginNavigation() {
      return host.pluginNavigation();
    },
    ...controller.positionedMenuHandlers("customize"),
    onToggleRoute: (routeId) =>
      toggleEntry(serializeSidebarEntry({ type: "route", route: routeId })),
    onTogglePlugin: (key) => toggleEntry(serializeSidebarEntry({ type: "plugin", key })),
    onReset: () => {
      // Canonical list, not the render list: unknown-state session slots
      // (other agents, still-loading caches) must survive a route reset.
      const sessions = host
        .reconciledSidebarZone()
        .sidebarEntries.filter((entry) => entry.startsWith("session:"));
      host.onUpdateSidebarEntries?.([...DEFAULT_SIDEBAR_ENTRIES, ...sessions]);
      controller.closePositionedMenu("customize", { restoreFocus: true });
    },
  });
}

export function renderSidebarAgentMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.agentMenuPosition;
  if (!position) {
    return undefined;
  }
  const trigger = controller.agentMenuTrigger;
  const chipAgent = createMemo(() => host.activeChipAgent()),
    activeId = createMemo(() => chipAgent().activeId),
    agent = createMemo(() => chipAgent().agent),
    agents = createMemo(() => chipAgent().agents, { equals: false }),
    identity = createMemo(() => chipAgent().identity),
    identities = createMemo(() => chipAgent().identities, { equals: false });
  return renderSidebarAgentMenu({
    get position() {
      return position;
    },
    get basePath() {
      return host.basePath;
    },
    get activeId() {
      return agent() ? activeId() : "";
    },
    get activeName() {
      return agent() ? normalizeAgentLabel(agent(), identity()) : "";
    },
    get agents() {
      return agents();
    },
    get identities() {
      return identities();
    },
    get pinnedAgentIds() {
      return host.pinnedAgentIds;
    },
    onTogglePinnedAgent: async (agentId) => {
      if (host.sessionDataContext) {
        togglePinnedAgent(host.sessionDataContext.navigation, agentId);
        await host.updateComplete;
      }
    },
    get query() {
      return controller.agentMenuQuery;
    },
    onQueryChange: (query) => controller.setAgentMenuQuery(query),
    get rosterMode() {
      return host.sidebarAgentsMode === "roster";
    },
    onToggleRoster: () => {
      patchSettings({
        sidebarAgentsMode: host.sidebarAgentsMode === "roster" ? "chip" : "roster",
      });
      void host.updateComplete.then(() => {
        host
          .querySelector<HTMLElement>(".sidebar-workspace-header__main, .sidebar-agent-card__main")
          ?.focus();
      });
    },
    get connected() {
      return host.connected;
    },
    resolveAvatarUrl: (url) => controller.agentMenuAvatars.resolve(url),
    avatarErrorHandler: (url) => controller.agentMenuAvatars.imageErrorHandler(url),
    get openMode() {
      return controller.agentMenuInteractionState === "open-hover" ? "hover" : "click";
    },
    agentUnreadCount: (agentId) => host.agentUnreadCount(agentId),
    onPointerEnter: () => controller.handleAgentMenuPointerEnter(),
    onPointerLeave: () => controller.handleAgentMenuPointerLeave(),
    onAfterShow: () => controller.restoreFocusAfterAgentMenuHoverOpen(),
    onSwitchAgent: (agentId) => {
      if (host.sidebarAgentsMode === "roster") {
        patchSettings({ sidebarAgentsMode: "chip" });
      }
      host.switchChipAgent(agentId);
    },
    onAskCapabilities: (agentId) => host.askAgentCapabilities(agentId),
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.agentMenuPosition !== position) {
        return;
      }
      controller.closeAgentMenu({ restoreFocus });
    },
    onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
  });
}

export function renderSidebarIdentityMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.identityMenuPosition;
  if (!position) {
    return undefined;
  }
  const selfUser = createMemo(
    () =>
      host.sessionDataContext
        ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
        : null,
    { equals: false },
  );
  const context = () => host.sessionDataContext;
  const overlaySnapshot = createMemo(() => context()?.overlays.snapshot, { equals: false });
  const updateAttentionDismissal = createMemo(() =>
    resolveUpdateAttentionDismissal({
      gatewayBootId: context()?.gateway.snapshot.hello?.server?.bootId,
      updateAvailable: overlaySnapshot()?.updateAvailable,
      updateSchedule: overlaySnapshot()?.updateSchedule,
    }),
  );
  const updateAttentionDismissed = createMemo(() =>
    Boolean(
      context() &&
      updateAttentionDismissal() &&
      isUpdateActionable(
        overlaySnapshot()?.updateAvailable,
        overlaySnapshot()?.updateSchedule,
        Boolean(overlaySnapshot()?.updateRunning || overlaySnapshot()?.updateReconciliationPending),
      ) &&
      !overlaySnapshot()?.updateRunning &&
      !overlaySnapshot()?.updateReconciliationPending &&
      overlaySnapshot()?.updateSchedule?.campaign?.state !== "applying" &&
      !isUpdateAttentionForced(overlaySnapshot()?.updateStatusBanner?.tone) &&
      isSidebarAttentionDismissed(
        loadDismissals(resolveSidebarAttentionKey(context()!.gateway)),
        updateAttentionDismissal()!,
      ),
    ),
  );
  return renderSidebarIdentityMenu({
    get nativeGatewaySnapshot() {
      return host.nativeGatewaySnapshot;
    },
    get position() {
      return position;
    },
    get canPairDevice() {
      return host.canPairDevice;
    },
    get basePath() {
      return host.basePath;
    },
    get gatewayVersion() {
      return host.gatewayVersion;
    },
    get updateAttentionDismissed() {
      return updateAttentionDismissed();
    },
    get profileViewer() {
      return selfUser() ? { ...selfUser(), watchedSessions: [] } : undefined;
    },
    get canRetryConnection() {
      return canRetryGatewayStatus(host.connectionStatus);
    },
    get themeMode() {
      return host.themeMode;
    },
    get triggerWidth() {
      return position.width;
    },
    ...controller.positionedMenuHandlers("identity"),
    onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
    onPairMobile: () => host.onPairMobile?.(),
    get onRetryConnect() {
      return host.onRetryConnect;
    },
  });
}

export function renderSidebarSessionMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const menu = controller.sessionMenu;
  if (!menu) {
    return undefined;
  }
  const context = () => host.sessionDataContext;
  const pluginActionSignal = createMemo(() => controller.pluginActionLifetime.signal);
  const currentSession = createMemo(() => host.findSidebarMenuSessionByKey(menu.session.key), {
    equals: false,
  });
  // Read again at dispatch: session updates can arrive before the menu rerenders.
  const currentPluginSession = () =>
    host.sessionData.sessionsResult?.sessions.find(
      (row) => row.key === menu.session.key && row.sessionId === menu.session.sessionId,
    );
  const pluginSession = createMemo(() => currentPluginSession(), { equals: false });
  // Appearance editing keeps this menu open. Refresh its row without adopting
  // a replacement session that happens to reuse the captured key.
  const session = createMemo(
    () => {
      const current = currentSession();
      return current && current.sessionId === menu.session.sessionId ? current : menu.session;
    },
    { equals: false },
  );
  const mainKey = createMemo(() =>
    resolveUiConfiguredMainKey({
      agentsList: host.sessionDataContext?.agents.state.agentsList,
      hello: host.sessionDataContext?.gateway.snapshot.hello,
    }),
  );
  const selection = createMemo(() => host.selectedVisibleSessions(), { equals: false });
  const batchRows = createMemo(() =>
    selection().length > 1 && selection().some((row) => row.key === session().key)
      ? selection()
      : null,
  );
  const rows = createMemo(() => batchRows() ?? [session()]);
  const archiveAllowed = createMemo(() =>
    rows().every((row) => canArchiveSessionRow(row, mainKey())),
  );
  const deleteAllowed = createMemo(() => canDeleteSessionRows(rows(), mainKey()));
  // Hidden runs have no row of their own; their parent menu acknowledges them.
  const hiddenUnreadRuns = createMemo(() =>
    rows().flatMap((row) => row.subagentSummary?.unreadHiddenRuns ?? []),
  );
  const allUnread = createMemo(() =>
    rows().every((row) => row.unread || (row.subagentSummary?.unreadHiddenRuns?.length ?? 0) > 0),
  );
  const allArchived = createMemo(() => rows().every((row) => row.archived === true));
  const sharedCategory = createMemo(() =>
    rows().every((row) => (row.category ?? null) === (rows()[0]?.category ?? null))
      ? (rows()[0]?.category ?? null)
      : null,
  );
  const cloudWorkerStopAction = createMemo(() => session().cloudWorkerStopAction);
  const cloudWorkerStopAllowed = createMemo(() => {
    const action = cloudWorkerStopAction();
    const currentContext = context();
    return Boolean(
      !batchRows() &&
      action &&
      (!action.blocksActiveRun || !session().hasActiveRun) &&
      currentContext &&
      isGatewayMethodAdvertised(currentContext.gateway.snapshot, action.method) === true,
    );
  });
  const selfUser = createMemo(() => context()?.gateway.snapshot.selfUser ?? null, {
    equals: false,
  });
  const assignmentAccess = createMemo(() =>
    host.readSessionMutationAccess({
      method: "sessions.assignOwner",
      params: { key: session().key, owner: { type: "human", id: selfUser()?.id ?? "profile" } },
      requiredScope: "operator.write",
    }),
  );
  const actionDisabledReasons = createMemo(() => {
    const access = assignmentAccess();
    return {
      ...sessionMenuReasons({
        snapshot: context()?.gateway.snapshot,
        session: session(),
        batchRows: batchRows(),
        cloudWorkerStopAction: session().cloudWorkerStopAction,
      }),
      ...(!access.allowed ? { "assign-owner": access.reason } : {}),
    };
  });
  return (
    <Show when={menu} keyed>
      {(_identity) => (
        <openclaw-session-menu
          prop:session={{
            label: session().label,
            target: { key: session().key, agentId: session().agentId },
            sessionId: session().sessionId ?? null,
            isChild: session().isChild,
            hasChildren: session().childSessionKeys.length > 0,
            pinned: session().pinned,
            pinnable: session().pinnable,
            unread: allUnread(),
            hiddenFromInvolvingMe: session().hiddenFromInvolvingMe,
            communication: session().communication,
            effectiveCommunication: session().effectiveCommunication,
            archived: allArchived(),
            snoozedUntil: session().snoozedUntil ?? null,
            archiving: rows().some(
              (row) => context()?.sessions.archiveVisibility(row.key) === "pending",
            ),
            category: batchRows() ? sharedCategory() : (session().category ?? null),
            icon: batchRows() ? null : (session().icon ?? null),
            color: batchRows() ? null : (session().color ?? null),
            categoryClearReturnsToGroups:
              sharedCategory() !== null &&
              rows().every((row) => categoryClearReturnsToGroups(row, host.sessionsGrouping)),
          }}
          prop:selectionCount={rows().length}
          prop:compact={isMobileNavLayout()}
          prop:lastActive={batchRows() ? "" : formatSidebarTimestamp(session().updatedAt)}
          prop:anchor={menu}
          prop:trigger={controller.sessionMenuTrigger}
          prop:disabled={!host.connected}
          prop:actionDisabledReasons={actionDisabledReasons()}
          prop:navigationAllowed={Boolean(context())}
          prop:copyMarkdownAllowed={canCopySessionMarkdown(context()?.gateway.snapshot)}
          prop:splitAllowed={canSplitSessionView()}
          prop:forkDisabled={host.sessionData.sessionsLoading || session().modelSelectionLocked}
          prop:forkFromLastCompleted={session().gatewayHasActiveRun ?? session().hasActiveRun}
          prop:snoozeAllowed={true}
          prop:archiveAllowed={archiveAllowed()}
          prop:deleteAllowed={deleteAllowed()}
          prop:cloudWorkerStopAllowed={cloudWorkerStopAllowed()}
          prop:groups={host.knownSessionGroups()}
          prop:currentOwner={session().owner?.actor ?? null}
          prop:work={batchRows() ? null : controller.sessionMenuWork}
          prop:pluginActions={
            !batchRows() && context()?.plugins && pluginSession()
              ? pluginSessionMenuActions(context()!.plugins, pluginSession()!)
              : []
          }
          prop:onClose={() => {
            if (controller.sessionMenu === menu) {
              controller.closeSessionMenu();
            }
          }}
          prop:onAction={(action: SessionMenuAction) => {
            const actionContext = context();
            const actionSignal = pluginActionSignal();
            if (batchRows()) {
              void host.sessionOrganizer.runBatchSessionAction(action, batchRows(), allUnread());
              return;
            }
            switch (action.kind) {
              case "open-pr":
                openExternalUrlSafe(action.url);
                break;
              case "open-in":
                openEditor(action.editor, action.path);
                break;
              case "copy-session-id":
              case "copy-session-link":
              case "copy-session-preview-link":
              case "copy-markdown":
              case "open-new-tab":
              case "open-new-window":
              case "split-right":
              case "split-below":
                if (actionContext) {
                  const selectedAgentId = host.getSessionNavigationState().selectedAgentId;
                  void runSessionNavigationAction(action.kind, {
                    context: actionContext,
                    session: session(),
                    agentId: selectedAgentId,
                    isCurrent: () =>
                      host.sessionDataContext === actionContext &&
                      host.getSessionNavigationState().selectedAgentId === selectedAgentId,
                  });
                }
                break;
              case "toggle-pin":
                void host.sessionOrganizer.patchSession(
                  session(),
                  { pinned: !session().pinned },
                  {
                    sessionScope: true,
                  },
                );
                break;
              case "toggle-involving-me":
                void host.sessionOrganizer.setSessionInvolvement(
                  session(),
                  !session().hiddenFromInvolvingMe,
                );
                break;
              case "toggle-unread":
                if (hiddenUnreadRuns().length > 0) {
                  void host.sessionOrganizer.runBatchSessionAction(action, rows(), allUnread());
                } else {
                  void host.sessionOrganizer.patchSession(session(), {
                    unread: !session().unread,
                  });
                }
                break;
              case "rename":
                void host.sessionOrganizer.renameSession(session());
                break;
              case "set-color":
                void host.sessionOrganizer.patchSession(session(), { color: action.color });
                break;
              case "set-icon":
                void host.sessionOrganizer.patchSession(session(), { icon: action.icon });
                break;
              case "set-communication":
                void host.sessionOrganizer.patchSession(session(), {
                  communication: action.communication,
                });
                break;
              case "reset-appearance":
                void host.sessionOrganizer.patchSession(session(), { icon: null, color: null });
                break;
              case "assign-owner":
                void host.sessionOrganizer.assignSessionOwner(session(), action.owner);
                break;
              case "fork":
                void host.sessionOrganizer.forkSession(session());
                break;
              case "plugin":
                if (actionContext?.plugins) {
                  void runControlUiPluginAction({
                    runtime: actionContext.plugins,
                    id: action.id,
                    placement: "session",
                    sessionKey: menu.session.key,
                    session: currentPluginSession(),
                    signal: actionSignal,
                  }).catch((error: unknown) => {
                    if (!actionSignal.aborted) {
                      showToast({
                        message: error instanceof Error ? error.message : String(error),
                      });
                    }
                  });
                }
                break;
              case "move-to-top-level":
                void host.sessionOrganizer.promoteSession(session());
                break;
              case "archive-tree":
                void host.sessionOrganizer.archiveSessionTreeWithUndo(session());
                break;
              case "move-to-group":
                if (action.category === null || session().category !== action.category) {
                  void host.sessionOrganizer.assignSessionCategory(session(), action.category);
                }
                break;
              case "new-group":
                void host.sessionOrganizer.createSessionGroup([session()]);
                break;
              case "snooze":
                void host.sessionOrganizer.snoozeSessionWithUndo(session(), action.snoozedUntil);
                break;
              case "wake":
                void host.sessionOrganizer.patchSession(
                  session(),
                  { snoozedUntil: null },
                  { sessionScope: true },
                );
                break;
              case "toggle-archived":
                if (session().archived) {
                  void host.sessionOrganizer.patchSession(
                    session(),
                    { archived: false },
                    {
                      sessionScope: true,
                    },
                  );
                } else {
                  void host.sessionOrganizer.archiveSessionWithUndo(session());
                }
                break;
              case "stop-cloud-worker":
                void host.sessionOrganizer.stopCloudWorker(session());
                break;
              case "delete":
                void host.sessionOrganizer.deleteSession(session());
                break;
              default:
                action satisfies never;
            }
          }}
        />
      )}
    </Show>
  );
}

export function renderSidebarMoreMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.moreMenuPosition;
  if (!position) {
    return undefined;
  }
  return renderSidebarMoreMenu({
    get position() {
      return position;
    },
    get basePath() {
      return host.basePath;
    },
    get activeRouteId() {
      return host.activeRouteId;
    },
    get sidebarEntries() {
      return host.sidebarEntries;
    },
    isRouteEnabled: (routeId) => controller.isRouteEnabled(routeId),
    ...controller.positionedMenuHandlers("more"),
    onNavigateRoute: (routeId) => {
      controller.closePositionedMenu("more", { restoreFocus: true });
      host.onNavigate?.(routeId);
    },
    onPreloadRoute: (routeId, event) => controller.preloadRoute(routeId, event),
    onCancelPreload: (event) => controller.cancelPreload(event),
    onEditPinnedItems: () => {
      const customizePosition = controller.moreMenuPosition;
      const customizeTrigger = controller.moreMenuTrigger;
      if (customizePosition) {
        controller.openCustomizeMenu(customizePosition.x, customizePosition.y, customizeTrigger);
      }
    },
  });
}
