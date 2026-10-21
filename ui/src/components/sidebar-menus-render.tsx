import { getObserver } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { createMemo, lazy, Loading, Show } from "solid-js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { patchSettings } from "../app/settings.ts";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { openEditor } from "../lib/editor-links.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { IdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { projectGateway, projectOverlays } from "../lib/reactive/application.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import { categoryClearReturnsToGroups } from "../lib/sessions/grouping.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  resolveUiConfiguredMainKey,
  parseAgentSessionKey,
  scopedSessionArtifactKey,
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
import { renderSidebarPeopleFilterMenuForMenus } from "./app-sidebar-people-filter-menu.tsx";
import { renderSidebarPluginNavigationMenuForMenus } from "./app-sidebar-plugin-navigation-menu.tsx";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import { findActiveSidebarLineageRow } from "./app-sidebar-session-lookup.ts";
import {
  renderSidebarCatalogViewMenuForMenus,
  renderSidebarSessionGroupMenuForMenus,
  renderSidebarSessionSortMenuForMenus,
} from "./app-sidebar-session-menu-renderers.tsx";
import "../styles/sidebar-menus.css";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { canRetryGatewayStatus } from "./gateway-status.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";
import {
  SessionMenu,
  type SessionMenuAction,
  type SessionMenuWork,
} from "./session-menu-solid.tsx";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import { moveSessionFromMenu, sessionPlacementAction } from "./session-placement-action.ts";
import { isUpdateAttentionForced } from "./sidebar-attention-dismissals.ts";
import { isReleaseUpdateAvailable } from "./sidebar-attention-update.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import type { MenuEntry } from "./solid/menu.tsx";

export { CatalogSessionMenu } from "./catalog-session-menu-solid.tsx";

const AgentCreateDialog = lazy(() => import("./agent-create-dialog.tsx"), {
  export: "AgentCreateDialog",
});

registerAgentCreationEnglish();

export function SidebarMenusRenderer(props: {
  menus: SidebarMenus;
  host: SidebarMenusOwner;
  avatars: IdentityAvatars;
  revision: () => number;
}) {
  return <>{renderSidebarMenus(props.menus, props.host, props.avatars, props.revision)}</>;
}

function renderSidebarMenus(
  menus: SidebarMenus,
  view: SidebarMenusOwner,
  agentMenuAvatars: IdentityAvatars,
  revision: () => number,
): JSX.Element {
  const avatars = projectOwner(agentMenuAvatars, (owner) => owner);
  // Read through without copying identities or filtering same-owner publications.
  const projected = new Proxy(menus, {
    get(target, key, receiver) {
      if (getObserver()) {
        revision();
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return [
    <Show when={projected.railPinMenuPosition} keyed>
      {(menu) => renderSidebarRailPinMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.pluginNavigationMenuPosition} keyed>
      {(menu) => renderSidebarPluginNavigationMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.agentMenuPosition} keyed>
      {(menu) =>
        agentMenuAvatars.withActiveRoutes(() =>
          renderSidebarAgentMenuForMenus(projected, view, menu, avatars.read),
        )
      }
    </Show>,
    <Show when={projected.agentCreateDialogOpen}>
      {renderSidebarAgentCreateDialogForMenus(projected, view)}
    </Show>,
    <Show when={projected.identityMenuPosition} keyed>
      {(menu) => renderSidebarIdentityMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.sessionMenu} keyed>
      {(menu) => renderSidebarSessionMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.sessionGroupMenu} keyed>
      {(menu) => renderSidebarSessionGroupMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.sessionSortMenuPosition} keyed>
      {(menu) => renderSidebarSessionSortMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.peopleFilterMenuPosition} keyed>
      {(menu) => renderSidebarPeopleFilterMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.catalogViewMenuPosition} keyed>
      {(menu) => renderSidebarCatalogViewMenuForMenus(projected, view, menu)}
    </Show>,
  ];
}

export function createSessionMenuWork(
  host: SidebarMenusOwner,
  setWork: (work: SessionMenuWork | null) => void,
) {
  const sessionMenuWorkOwner = {};
  let sessionMenuWorkStore: ReturnType<typeof sessionPullRequestsForGateway> | null = null;
  let stopSessionMenuGateway: (() => void) | undefined;
  let sessionMenuWorkVersion = 0;

  function releaseSessionMenuWork() {
    sessionMenuWorkVersion += 1;
    stopSessionMenuGateway?.();
    stopSessionMenuGateway = undefined;
    sessionMenuWorkStore?.unwatch(sessionMenuWorkOwner);
    sessionMenuWorkStore = null;
  }

  function loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++sessionMenuWorkVersion;
    const context = host.sessionDataContext;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    setWork(
      session.worktreeId
        ? {
            pullRequestUrl: null,
            worktreePath: null,
          }
        : null,
    );
    if (!session.worktreeId || !context) {
      return;
    }
    // A replacement connection retires pending menu work before starting its successor.
    stopSessionMenuGateway = context.gateway.subscribe((next) => {
      if (next.phase === "connected" && next.client !== client) {
        releaseSessionMenuWork();
        loadSessionMenuWork(session);
      }
    });
    if (!client) {
      return;
    }
    const { selectedAgentId } = host.getSessionNavigationState();
    const store = (sessionMenuWorkStore = sessionPullRequestsForGateway(context.gateway));
    const pullRequestKey = scopedSessionArtifactKey(
      session.key,
      parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
    );
    void fetchSessionMenuWork({
      client,
      loadPullRequests: canCallGatewayMethod(
        context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(sessionMenuWorkOwner, pullRequestKey)
        : undefined,
      worktreeId: session.worktreeId,
      execNode: session.execNode,
    }).then((work) => {
      if (
        version === sessionMenuWorkVersion &&
        // A replacement provider wrapper may retain the same Gateway and client.
        host.sessionDataContext?.gateway === context.gateway &&
        context.gateway.snapshot.client === client
      ) {
        setWork(work);
      }
    });
  }

  return { load: loadSessionMenuWork, release: releaseSessionMenuWork };
}

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
  const items = createMemo<MenuEntry[]>(() => [
    renderSidebarMenuAction("before", t("chat.sidebar.moveUp"), "arrowUp", {
      disabled: !before,
    }),
    renderSidebarMenuAction("after", t("chat.sidebar.moveDown"), "arrowDown", {
      disabled: !after,
    }),
    renderSidebarMenuAction("remove", t("nav.unpin"), "pin"),
  ]);
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
        items={items()}
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
  const agents = createMemo(() => {
    const source = host.sessionDataContext?.agents;
    return source && projectAgents(source);
  });
  const gateway = createMemo(() => {
    const source = host.sessionDataContext?.gateway;
    return source && projectGateway(source);
  });
  const preferences = createMemo(() => {
    const source = host.sessionDataContext?.theme;
    return source && projectTheme(source).preferences;
  });
  return (
    <SidebarAgentMenu
      {...{
        position,
        ref: menuRef,
        basePath: host.basePath,
        activeId: chipAgent().agent ? chipAgent().activeId : "",
        agents: chipAgent().agents,
        identities: chipAgent().identities,
        pendingAgent: agents()?.read().pendingAgent,
        recentlyCreatedAgentId:
          agents()?.read().recentlyCreatedAgentId ??
          preferences()?.read().sidebarRecentlyCreatedAgentId,
        rosterMode: host.sidebarAgentsMode === "roster" && !chipAgent().pending,
        creationDisabledReason: canCallGatewayMethod(
          gateway()?.read().snapshot,
          "agents.create",
          "operator.admin",
        )
          ? null
          : t("agentChip.creationUnavailable"),
        onShowAllAgents: () => {
          host.navigationView = "sessions";
          host.sessionDataContext?.navigation.update({ navCollapsed: false });
          patchSettings({ sidebarAgentsMode: "roster" });
          host.sessionDataContext?.agentSelection.setScope(null);
          host.onNavigate?.("sessions");
          void menus.commit().then((committed) => {
            if (!committed) {
              return;
            }
            menus.focusAgentRoster?.();
          });
        },
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
        onCreateAgent: () => {
          if (host.sessionDataContext) {
            menus.closeAgentMenu();
            menus.openAgentCreateDialog();
          }
        },
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

export function renderSidebarAgentCreateDialogForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
): JSX.Element | null {
  const context = host.sessionDataContext;
  if (!context) {
    return null;
  }
  return (
    <Loading>
      <AgentCreateDialog
        context={context}
        onCancel={() => menus.closeAgentCreateDialog()}
        onCreate={(identity) => {
          menus.closeAgentCreateDialog();
          void import("../app/create-agent.ts").then(({ createApplicationAgent }) =>
            createApplicationAgent(context, identity),
          );
        }}
      />
    </Loading>
  );
}

function renderSidebarIdentityMenuForMenus(
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
        onThemeChange: (mode, element) => host.sessionDataContext?.theme.setMode(mode, element),
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
      ...(!host.connected ? { plugin: t("sessionsView.actionRequiresConnection") } : {}),
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
      disabled={false}
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
          default:
            void host.sessionOrganizer.runSessionAction(session(), action);
        }
      }}
    />
  );
}
