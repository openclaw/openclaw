import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { patchSettings } from "../app/settings.ts";
import { isUpdateActionable } from "../app/update-schedule-projection.ts";
import { t } from "../i18n/index.ts";
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
import { renderSidebarAgentMenu } from "./app-sidebar-agent-menu.ts";
import { renderSidebarIdentityMenu } from "./app-sidebar-identity-menu.ts";
import { renderSidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-nav-menus.ts";
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
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

export { focusActiveAgentMenuItem } from "./app-sidebar-agent-menu.ts";
export {
  renderSidebarCatalogViewMenuForController,
  renderSidebarSessionGroupMenuForController,
  renderSidebarSessionSortMenuForController,
} from "./app-sidebar-session-menu-renderers.ts";
export { renderSidebarPluginNavigationMenuForController } from "./app-sidebar-plugin-navigation-menu.ts";
export { renderSidebarPeopleFilterMenuForController } from "./app-sidebar-people-filter-menu.ts";

export function renderSidebarRailPinMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.railPinMenuPosition;
  if (!position || !host.sidebarEntries.includes(position.entry)) {
    return nothing;
  }
  const entries = [...host.querySelectorAll<HTMLElement>(".sidebar-rail__pin")].map(
    (pin) => pin.dataset.sidebarEntry!,
  );
  const index = entries.indexOf(position.entry);
  const before = index >= 0 ? entries[index - 1] : undefined;
  const after = index >= 0 ? entries[index + 1] : undefined;
  const trigger = controller.railPinMenuTrigger;
  return renderSidebarDropdown({
    position,
    className: "sidebar-customize-menu sidebar-rail-pin-menu",
    label: t("chat.sidebar.reorderItem", { item: position.label }),
    ...controller.positionedMenuHandlers("railPin"),
    onSelect: ({ value }) => {
      controller.closePositionedMenu("railPin");
      if (value === "remove") {
        host.sessionOrganizer.removeSidebarEntry(position.entry);
      } else if (value === "before" || value === "after") {
        const target = value === "before" ? before : after;
        if (target) {
          host.sessionOrganizer.writeSidebarEntryAt(position.entry, target, value);
          void host.updateComplete.then(() => trigger?.isConnected && trigger.focus());
        }
      }
    },
    content: html`
      ${renderSidebarMenuAction("before", t("chat.sidebar.moveUp"), "arrowUp", { disabled: !before })}
      ${renderSidebarMenuAction("after", t("chat.sidebar.moveDown"), "arrowDown", { disabled: !after })}
      ${renderSidebarMenuAction("remove", t("nav.unpin"), "pin")}
    `,
  });
}

export function renderSidebarAgentMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.agentMenuPosition;
  if (!position) {
    return nothing;
  }
  const trigger = controller.agentMenuTrigger;
  const { activeId, agent, agents, identity, identities } = host.activeChipAgent();
  return renderSidebarAgentMenu({
    position,
    basePath: host.basePath,
    activeId: agent ? activeId : "",
    activeName: agent ? normalizeAgentLabel(agent, identity) : "",
    agents,
    identities,
    pinnedAgentIds: host.pinnedAgentIds,
    onTogglePinnedAgent: async (agentId) => {
      if (host.sessionDataContext) {
        togglePinnedAgent(host.sessionDataContext.navigation, agentId);
        await host.updateComplete;
      }
    },
    query: controller.agentMenuQuery,
    onQueryChange: (query) => controller.setAgentMenuQuery(query),
    rosterMode: host.sidebarAgentsMode === "roster",
    onToggleRoster: () => {
      host.sidebarAgentsMode = host.sidebarAgentsMode === "roster" ? "chip" : "roster";
      patchSettings({ sidebarAgentsMode: host.sidebarAgentsMode });
      void host.updateComplete.then(() => {
        host
          .querySelector<HTMLElement>(".sidebar-workspace-header__main, .sidebar-agent-card__main")
          ?.focus();
      });
    },
    connected: host.connected,
    resolveAvatarUrl: (url) => controller.agentMenuAvatars.resolve(url),
    avatarErrorHandler: (url) => controller.agentMenuAvatars.imageErrorHandler(url),
    openMode: controller.agentMenuInteractionState === "open-hover" ? "hover" : "click",
    agentUnreadCount: (agentId) => host.agentUnreadCount(agentId),
    onPointerEnter: () => controller.handleAgentMenuPointerEnter(),
    onPointerLeave: () => controller.handleAgentMenuPointerLeave(),
    onAfterShow: () => controller.restoreFocusAfterAgentMenuHoverOpen(),
    onSwitchAgent: (agentId) => {
      if (host.sidebarAgentsMode === "roster") {
        host.sidebarAgentsMode = "chip";
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

export function renderSidebarIdentityMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.identityMenuPosition;
  if (!position) {
    return nothing;
  }
  const selfUser = host.sessionDataContext
    ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
    : null;
  const context = host.sessionDataContext;
  const overlaySnapshot = context?.overlays.snapshot;
  const updateAttentionDismissal = resolveUpdateAttentionDismissal({
    gatewayBootId: context?.gateway.snapshot.hello?.server?.bootId,
    updateAvailable: overlaySnapshot?.updateAvailable,
    updateSchedule: overlaySnapshot?.updateSchedule,
  });
  const updateAttentionDismissed = Boolean(
    context &&
    updateAttentionDismissal &&
    isUpdateActionable(
      overlaySnapshot?.updateAvailable,
      overlaySnapshot?.updateSchedule,
      Boolean(overlaySnapshot?.updateRunning || overlaySnapshot?.updateReconciliationPending),
    ) &&
    !overlaySnapshot?.updateRunning &&
    !overlaySnapshot?.updateReconciliationPending &&
    overlaySnapshot?.updateSchedule?.campaign?.state !== "applying" &&
    !isUpdateAttentionForced(overlaySnapshot?.updateStatusBanner?.tone) &&
    isSidebarAttentionDismissed(
      loadDismissals(resolveSidebarAttentionKey(context.gateway)),
      updateAttentionDismissal,
    ),
  );
  return renderSidebarIdentityMenu({
    position,
    canPairDevice: host.canPairDevice,
    basePath: host.basePath,
    gatewayVersion: host.gatewayVersion,
    updateAttentionDismissed,
    profileViewer: selfUser ? { ...selfUser, watchedSessions: [] } : undefined,
    canRetryConnection: canRetryGatewayStatus(host.connectionStatus),
    themeMode: host.themeMode,
    triggerWidth: position.width,
    ...controller.positionedMenuHandlers("identity"),
    onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
    onPairMobile: () => host.onPairMobile?.(),
    onRetryConnect: host.onRetryConnect,
  });
}

export function renderSidebarSessionMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const menu = controller.sessionMenu;
  if (!menu) {
    return nothing;
  }
  const context = host.sessionDataContext;
  const pluginActionSignal = controller.pluginActionLifetime.signal;
  const currentSession = host.findSidebarMenuSessionByKey(menu.session.key);
  // Read again at dispatch: session updates can arrive before the menu rerenders.
  const currentPluginSession = () =>
    host.sessionData.sessionsResult?.sessions.find(
      (row) => row.key === menu.session.key && row.sessionId === menu.session.sessionId,
    );
  const pluginSession = currentPluginSession();
  // Appearance editing keeps this menu open. Refresh its row without adopting
  // a replacement session that happens to reuse the captured key.
  const session =
    currentSession && currentSession.sessionId === menu.session.sessionId
      ? currentSession
      : menu.session;
  const mainKey = resolveUiConfiguredMainKey({
    agentsList: host.sessionDataContext?.agents.state.agentsList,
    hello: host.sessionDataContext?.gateway.snapshot.hello,
  });
  const selection = host.selectedVisibleSessions();
  const batchRows =
    selection.length > 1 && selection.some((row) => row.key === session.key) ? selection : null;
  const rows = batchRows ?? [session];
  const archiveAllowed = rows.every((row) => canArchiveSessionRow(row, mainKey));
  const deleteAllowed = canDeleteSessionRows(rows, mainKey);
  // Hidden runs have no row of their own; their parent menu acknowledges them.
  const hiddenUnreadRuns = rows.flatMap((row) => row.subagentSummary?.unreadHiddenRuns ?? []);
  const allUnread = rows.every(
    (row) => row.unread || (row.subagentSummary?.unreadHiddenRuns?.length ?? 0) > 0,
  );
  const allArchived = rows.every((row) => row.archived === true);
  const sharedCategory = rows.every((row) => (row.category ?? null) === (rows[0]?.category ?? null))
    ? (rows[0]?.category ?? null)
    : null;
  const cloudWorkerStopAction = session.cloudWorkerStopAction;
  const cloudWorkerStopAllowed = Boolean(
    !batchRows &&
    cloudWorkerStopAction &&
    (!cloudWorkerStopAction.blocksActiveRun || !session.hasActiveRun) &&
    context &&
    isGatewayMethodAdvertised(context.gateway.snapshot, cloudWorkerStopAction.method) === true,
  );
  const selfUser = context?.gateway.snapshot.selfUser ?? null;
  const assignmentAccess = host.readSessionMutationAccess({
    method: "sessions.assignOwner",
    params: { key: session.key, owner: { type: "human", id: selfUser?.id ?? "profile" } },
    requiredScope: "operator.write",
  });
  const actionDisabledReasons = {
    ...sessionMenuReasons({
      snapshot: context?.gateway.snapshot,
      session,
      batchRows,
      cloudWorkerStopAction: session.cloudWorkerStopAction,
    }),
    ...(!assignmentAccess.allowed ? { "assign-owner": assignmentAccess.reason } : {}),
  };
  return keyed(
    menu,
    html`
      <openclaw-session-menu
        .session=${{
          label: session.label,
          target: { key: session.key, agentId: session.agentId },
          sessionId: session.sessionId ?? null,
          isChild: session.isChild,
          hasChildren: session.childSessionKeys.length > 0,
          pinned: host.sessionOrganizer.isPersonalSessionPin(session.key),
          pinnable: session.pinnable,
          unread: allUnread,
          hiddenFromInvolvingMe: session.hiddenFromInvolvingMe,
          communication: session.communication,
          effectiveCommunication: session.effectiveCommunication,
          archived: allArchived,
          snoozedUntil: session.snoozedUntil ?? null,
          archiving: rows.some((row) => context?.sessions.archiveVisibility(row.key) === "pending"),
          category: batchRows ? sharedCategory : (session.category ?? null),
          icon: batchRows ? null : (session.icon ?? null),
          color: batchRows ? null : (session.color ?? null),
          categoryClearReturnsToGroups:
            sharedCategory !== null &&
            rows.every((row) => categoryClearReturnsToGroups(row, host.sessionsGrouping)),
        }}
        .involvingMeContext=${host.sessionInvolvingMeFilterActive}
        .selectionCount=${rows.length}
        .compact=${isMobileNavLayout()}
        .lastActive=${batchRows ? "" : formatSidebarTimestamp(session.updatedAt)}
        .anchor=${menu}
        .trigger=${controller.sessionMenuTrigger}
        .disabled=${!host.connected}
        .actionDisabledReasons=${actionDisabledReasons}
        .navigationAllowed=${Boolean(context)}
        .copyMarkdownAllowed=${canCopySessionMarkdown(context?.gateway.snapshot)}
        .splitAllowed=${canSplitSessionView()}
        .forkDisabled=${host.sessionData.sessionsLoading || session.modelSelectionLocked}
        .forkFromLastCompleted=${session.gatewayHasActiveRun ?? session.hasActiveRun}
        .snoozeAllowed=${true}
        .archiveAllowed=${archiveAllowed}
        .deleteAllowed=${deleteAllowed}
        .cloudWorkerStopAllowed=${cloudWorkerStopAllowed}
        .groups=${host.knownSessionGroups()}
        .currentOwner=${session.owner?.actor ?? null}
        .work=${batchRows ? null : controller.sessionMenuWork}
        .pluginActions=${
          !batchRows && context?.plugins && pluginSession
            ? pluginSessionMenuActions(context.plugins, pluginSession)
            : []
        }
        .onClose=${() => {
          if (controller.sessionMenu === menu) {
            controller.closeSessionMenu();
          }
        }}
        .onAction=${(action: SessionMenuAction) => {
          if (batchRows) {
            void host.sessionOrganizer.runBatchSessionAction(action, batchRows, allUnread);
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
              if (context) {
                const selectedAgentId = host.getSessionNavigationState().selectedAgentId;
                void runSessionNavigationAction(action.kind, {
                  context,
                  session,
                  agentId: selectedAgentId,
                  isCurrent: () =>
                    host.sessionDataContext === context &&
                    host.getSessionNavigationState().selectedAgentId === selectedAgentId,
                });
              }
              break;
            case "toggle-pin":
              host.sessionOrganizer.setPersonalSessionPin(
                session.key,
                !host.sessionOrganizer.isPersonalSessionPin(session.key),
              );
              break;
            case "toggle-involving-me":
              void host.sessionOrganizer.setSessionInvolvement(
                session,
                !session.hiddenFromInvolvingMe,
              );
              break;
            case "toggle-unread":
              if (hiddenUnreadRuns.length > 0) {
                void host.sessionOrganizer.runBatchSessionAction(action, rows, allUnread);
              } else {
                void host.sessionOrganizer.patchSession(session, { unread: !session.unread });
              }
              break;
            case "rename":
              void host.sessionOrganizer.renameSession(session);
              break;
            case "set-color":
              void host.sessionOrganizer.patchSession(session, { color: action.color });
              break;
            case "set-icon":
              void host.sessionOrganizer.patchSession(session, { icon: action.icon });
              break;
            case "set-communication":
              void host.sessionOrganizer.patchSession(session, {
                communication: action.communication,
              });
              break;
            case "reset-appearance":
              void host.sessionOrganizer.patchSession(session, { icon: null, color: null });
              break;
            case "assign-owner":
              void host.sessionOrganizer.assignSessionOwner(session, action.owner);
              break;
            case "fork":
              void host.sessionOrganizer.forkSession(session);
              break;
            case "plugin":
              if (context?.plugins) {
                void runControlUiPluginAction({
                  runtime: context.plugins,
                  id: action.id,
                  placement: "session",
                  sessionKey: menu.session.key,
                  session: currentPluginSession(),
                  signal: pluginActionSignal,
                }).catch((error: unknown) => {
                  if (!pluginActionSignal.aborted) {
                    showToast({ message: error instanceof Error ? error.message : String(error) });
                  }
                });
              }
              break;
            case "move-to-top-level":
              void host.sessionOrganizer.promoteSession(session);
              break;
            case "archive-tree":
              void host.sessionOrganizer.archiveSessionTreeWithUndo(session);
              break;
            case "move-to-group":
              if (action.category === null || session.category !== action.category) {
                void host.sessionOrganizer.assignSessionCategory(session, action.category);
              }
              break;
            case "new-group":
              void host.sessionOrganizer.createSessionGroup([session]);
              break;
            case "snooze":
              void host.sessionOrganizer.snoozeSessionWithUndo(session, action.snoozedUntil);
              break;
            case "wake":
              void host.sessionOrganizer.patchSession(
                session,
                { snoozedUntil: null },
                { sessionScope: true },
              );
              break;
            case "toggle-archived":
              if (session.archived) {
                void host.sessionOrganizer.patchSession(
                  session,
                  { archived: false },
                  {
                    sessionScope: true,
                  },
                );
              } else {
                void host.sessionOrganizer.archiveSessionWithUndo(session);
              }
              break;
            case "stop-cloud-worker":
              void host.sessionOrganizer.stopCloudWorker(session);
              break;
            case "delete":
              void host.sessionOrganizer.deleteSession(session);
              break;
            default:
              action satisfies never;
          }
        }}
      ></openclaw-session-menu>
    `,
  );
}
