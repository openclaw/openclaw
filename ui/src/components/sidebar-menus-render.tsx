import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { patchSettings } from "../app/settings.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { IdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { projectOverlays } from "../lib/reactive/application.ts";
import { t } from "../lib/reactive/i18n.ts";
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
import { renderSidebarAgentMenu as SidebarAgentMenu } from "./app-sidebar-agent-menu.tsx";
import { renderSidebarIdentityMenu as SidebarIdentityMenu } from "./app-sidebar-identity-menu.tsx";
import { SidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import { findActiveSidebarLineageRow } from "./app-sidebar-session-lookup.ts";
import { canRetryGatewayStatus } from "./gateway-status.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";
import "../styles/sidebar-menus.css";
import { SessionMenu, type SessionMenuAction } from "./session-menu-solid.tsx";
import { moveSessionFromMenu, sessionPlacementAction } from "./session-placement-action.ts";
import { isUpdateAttentionForced } from "./sidebar-attention-dismissals.ts";
import { isReleaseUpdateAvailable } from "./sidebar-attention-update.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";

export {
  renderSidebarCatalogViewMenuForMenus,
  renderSidebarSessionGroupMenuForMenus,
  renderSidebarSessionSortMenuForMenus,
} from "./app-sidebar-session-menu-renderers.tsx";
export { renderSidebarPluginNavigationMenuForMenus } from "./app-sidebar-plugin-navigation-menu.tsx";
export { renderSidebarPeopleFilterMenuForMenus } from "./app-sidebar-people-filter-menu.tsx";

export function renderSidebarRailPinMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["railPinMenuPosition"]>,
): JSX.Element {
  const entries = [...menus.railPins]
    .filter(([, element]) => element.isConnected)
    .toSorted(([, left], [, right]) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map(([entry]) => entry);
  const index = entries.indexOf(position.entry);
  const before = index >= 0 ? entries[index - 1] : undefined;
  const after = index >= 0 ? entries[index + 1] : undefined;
  const trigger = menus.triggers.get("railPin");
  return (
    <Show when={host.sidebarEntries.includes(position.entry)}>
      <SidebarDropdown
        position={position}
        class="sidebar-customize-menu sidebar-rail-pin-menu"
        label={t("chat.sidebar.reorderItem", { item: position.label })}
        {...menus.positionedMenuHandlers("railPin")}
        onSelect={(value) => {
          menus.closePositionedMenu("railPin");
          if (value === "remove") {
            host.sessionOrganizer.removeSidebarEntry(position.entry);
          } else if (value === "before" || value === "after") {
            const target = value === "before" ? before : after;
            if (target) {
              host.sessionOrganizer.writeSidebarEntryAt(position.entry, target, value);
              void menus
                .commit()
                .then((committed) => committed && trigger?.isConnected && trigger.focus());
            }
          }
        }}
        items={[
          renderSidebarMenuAction("before", t("chat.sidebar.moveUp"), "arrowUp", {
            disabled: !before,
          }),
          renderSidebarMenuAction("after", t("chat.sidebar.moveDown"), "arrowDown", {
            disabled: !after,
          }),
          renderSidebarMenuAction("remove", t("nav.unpin"), "pin"),
        ]}
      />
    </Show>
  );
}

export function renderSidebarAgentMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["agentMenuPosition"]>,
  avatars: () => IdentityAvatars,
): JSX.Element {
  const trigger = menus.triggers.get("agent");
  const menuRef = menus.menuRef("agent");
  const chipAgent = createMemo(() => host.activeChipAgent());
  const activeName = createMemo(() => {
    const current = chipAgent();
    return current.agent ? normalizeAgentLabel(current.agent, current.identity) : "";
  });
  return (
    <SidebarAgentMenu
      {...{
        position,
        ref: menuRef,
        basePath: host.basePath,
        activeId: chipAgent().agent ? chipAgent().activeId : "",
        activeName: activeName(),
        agents: chipAgent().agents,
        identities: chipAgent().identities,
        pinnedAgentIds: host.pinnedAgentIds,
        onTogglePinnedAgent: async (agentId) => {
          if (host.sessionDataContext) {
            togglePinnedAgent(host.sessionDataContext.navigation, agentId);
            await menus.commit();
          }
        },
        rosterMode: host.sidebarAgentsMode === "roster",
        onShowAllAgents: () => {
          host.navigationView = "sessions";
          host.sessionDataContext?.navigation.update({ navCollapsed: false });
          patchSettings({ sidebarAgentsMode: "roster" });
          void menus.commit().then((committed) => {
            if (!committed) {
              return;
            }
            menus.focusAgentRoster?.();
          });
        },
        connected: host.connected,
        resolveAvatarUrl: (url) => avatars().resolve(url),
        avatarErrorHandler: (url) => avatars().imageErrorHandler(url),
        openMode: menus.agentMenuMode,
        agentUnreadCount: (agentId) => host.agentUnreadCount(agentId),
        onPointerEnter: () => menus.handleAgentMenuPointerEnter(),
        onPointerLeave: () => menus.handleAgentMenuPointerLeave(),
        onAfterShow: () => menus.restoreFocusAfterAgentMenuHoverOpen(),
        onSwitchAgent: (agentId) => {
          if (host.sidebarAgentsMode === "roster") {
            patchSettings({ sidebarAgentsMode: "chip" });
          }
          host.switchChipAgent(agentId);
        },
        onAskCapabilities: (agentId) => host.askAgentCapabilities(agentId),
        anchor: trigger ?? undefined,
        onClose: (restoreFocus) => {
          if (menus.agentMenuPosition !== position) {
            return;
          }
          menus.closeAgentMenu({ restoreFocus });
        },
        onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
      }}
    />
  );
}

export function renderSidebarIdentityMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["identityMenuPosition"]>,
): JSX.Element {
  const selfUser = () =>
    host.sessionDataContext
      ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
      : null;
  const overlays = createMemo(() => {
    const source = host.sessionDataContext?.overlays;
    return source && projectOverlays(source);
  });
  const overlaySnapshot = () => overlays()?.read();
  const profileViewer = createMemo(() => {
    const user = selfUser();
    return user ? { ...user, watchedSessions: [] } : undefined;
  });
  const updateAvailable = createMemo(
    () =>
      isReleaseUpdateAvailable(
        overlaySnapshot()?.updateAvailable,
        overlaySnapshot()?.updateSchedule,
      ) &&
      !overlaySnapshot()?.updateRunning &&
      !overlaySnapshot()?.updateReconciliationPending &&
      overlaySnapshot()?.updateSchedule?.campaign?.state !== "applying" &&
      !isUpdateAttentionForced(overlaySnapshot()?.updateStatusBanner?.tone),
  );
  return (
    <SidebarIdentityMenu
      {...{
        nativeGatewaySnapshot: host.nativeGatewaySnapshot,
        position,
        canPairDevice: host.canPairDevice,
        basePath: host.basePath,
        gatewayVersion: host.gatewayVersion,
        updateAvailable: updateAvailable(),
        profileViewer: profileViewer(),
        canRetryConnection: canRetryGatewayStatus(host.connectionStatus),
        themeMode: host.themeMode,
        triggerWidth: position.width,
        ...menus.positionedMenuHandlers("identity"),
        onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
        onPairMobile: () => host.onPairMobile?.(),
        onRetryConnect: host.onRetryConnect,
      }}
    />
  );
}

export function renderSidebarSessionMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  menu: NonNullable<SidebarMenus["sessionMenu"]>,
): JSX.Element {
  const context = () => host.sessionDataContext;
  const pluginActionSignal = () => menus.pluginActionLifetime.signal;
  const currentSession = () => host.findSidebarMenuSessionByKey(menu.session.key);
  // Read again at dispatch: session updates can arrive before the menu rerenders.
  const currentPluginSession = () =>
    host.sessionData.sessionsResult?.sessions.find(
      (row) => row.key === menu.session.key && row.sessionId === menu.session.sessionId,
    );
  const currentPlacementSession = () => {
    const row =
      findActiveSidebarLineageRow(host.sessionData, menu.session.key) ??
      currentPluginSession() ??
      Object.values(host.sessionData.sessionResultsByAgent)
        .flatMap((result) => result.sessions)
        .find((candidate) => candidate.key === menu.session.key);
    return row?.sessionId === menu.session.sessionId ? row : undefined;
  };
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
  const cloudWorkerStopAction = () => session().cloudWorkerStopAction;
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
  const selfUser = () => context()?.gateway.snapshot.selfUser ?? null;
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
        placementRow: currentPlacementSession(),
        requiredProfile: context()?.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
        session: session(),
        batchRows: batchRows(),
        cloudWorkerStopAction: session().cloudWorkerStopAction,
      }),
      ...(!access.allowed ? { "assign-owner": access.reason } : {}),
    };
  });
  return (
    <SessionMenu
      session={{
        label: session().label,
        placementAction: sessionPlacementAction(currentPlacementSession()),
        target: { key: session().key, agentId: session().agentId },
        sessionId: session().sessionId ?? null,
        isChild: session().isChild,
        pinned: host.sessionOrganizer.isPersonalSessionPin(session().key),
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
      involvingMeContext={host.sessionInvolvingMeFilterActive}
      selectionCount={rows().length}
      compact={isMobileNavLayout()}
      lastActive={batchRows() ? "" : formatSidebarTimestamp(session().updatedAt)}
      anchor={menu}
      trigger={menus.triggers.get("session") ?? null}
      disabled={!host.connected}
      actionDisabledReasons={actionDisabledReasons()}
      navigationAllowed={Boolean(context())}
      copyMarkdownAllowed={canCopySessionMarkdown(context()?.gateway.snapshot)}
      splitAllowed={canSplitSessionView()}
      forkDisabled={host.sessionData.sessionsLoading || session().modelSelectionLocked}
      forkFromLastCompleted={session().gatewayHasActiveRun ?? session().hasActiveRun}
      snoozeAllowed={true}
      archiveAllowed={archiveAllowed()}
      deleteAllowed={deleteAllowed()}
      cloudWorkerStopAllowed={cloudWorkerStopAllowed()}
      groups={host.knownSessionGroups()}
      currentOwner={session().owner?.actor ?? null}
      work={batchRows() ? null : menus.sessionMenuWork}
      pluginActions={
        !batchRows() && context()?.plugins && currentPluginSession()
          ? pluginSessionMenuActions(context()!.plugins, currentPluginSession()!)
          : []
      }
      onClose={() => {
        if (menus.sessionMenu === menu) {
          menus.closeSessionMenu();
        }
      }}
      onAction={(action: SessionMenuAction) => {
        const actionContext = context();
        const actionSignal = pluginActionSignal();
        const batch = batchRows();
        if (batch) {
          void host.sessionOrganizer.runBatchSessionAction(action, batch, allUnread());
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
            host.sessionOrganizer.setPersonalSessionPin(
              session().key,
              !host.sessionOrganizer.isPersonalSessionPin(session().key),
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
              void host.sessionOrganizer.patchSession(
                session(),
                { unread: !session().unread },
                { sessionScope: true },
              );
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
          case "move-session": {
            const placementSession = currentPlacementSession();
            const scopeGeneration = host.sessionData.sessionScopeGeneration;
            if (actionContext && placementSession) {
              void moveSessionFromMenu({
                context: actionContext,
                row: placementSession,
                fallbackAgentId:
                  session().agentId ?? host.getSessionNavigationState().selectedAgentId,
                currentRow: currentPlacementSession,
                isCurrent: () =>
                  !actionSignal.aborted &&
                  host.sessionDataContext === actionContext &&
                  host.sessionData.sessionScopeGeneration === scopeGeneration,
              });
            }
            break;
          }
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
          case "move-to-group":
            if (action.category === null || session().category !== action.category) {
              void host.sessionOrganizer.assignSessionCategory(session(), action.category);
            }
            break;
          case "new-group":
            void host.sessionOrganizer.createSessionGroup([session()]);
            break;
          case "snooze":
            void host.sessionOrganizer.snoozeSessionWithUndo(
              session(),
              action.snoozedUntil,
              action.rememberCustom,
            );
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
  );
}
