import { getObserver } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { createMemo, lazy, Loading, Show } from "solid-js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { patchSettings } from "../app/settings.ts";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { openEditor } from "../lib/editor-links.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { IdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { projectGateway, projectOverlays } from "../lib/reactive/application.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
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
import { SidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-dropdown.tsx";
import { renderSidebarIdentityMenu as SidebarIdentityMenu } from "./app-sidebar-identity-menu.tsx";
import { renderSidebarPeopleFilterMenuForMenus } from "./app-sidebar-people-filter-menu.tsx";
import { renderSidebarPluginNavigationMenuForMenus } from "./app-sidebar-plugin-navigation-menu.tsx";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import { findActiveSidebarLineageRow } from "./app-sidebar-session-lookup.ts";
import {
  renderSidebarCatalogViewMenuForMenus,
  renderSidebarSessionGroupMenuForMenus,
  renderSidebarSessionSortMenuForMenus,
} from "./app-sidebar-session-menu-renderers.tsx";
import { canRetryGatewayStatus } from "./gateway-status.ts";
import "../styles/sidebar-menus.css";
import { sessionMenuReasons } from "./session-menu-access.ts";
import { SessionMenu, type SessionMenuAction } from "./session-menu-solid.tsx";
import { runSessionAction, runBatchSessionAction } from "./session-organizer-menu.runtime.ts";
import { moveSessionFromMenu, sessionPlacementAction } from "./session-placement-action.ts";
import { isUpdateAttentionForced } from "./sidebar-attention-dismissals.ts";
import { isReleaseUpdateAvailable } from "./sidebar-attention-update.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import { useAvatarGatewayContext } from "./solid/identity-avatar-view.ts";
import type { MenuEntry } from "./solid/menu.tsx";

export { SidebarCatalogMenu as CatalogSessionMenu } from "./app-sidebar-catalog-menu.runtime.tsx";
export { createSessionMenuWork } from "./session-menu-work.ts";

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
      {(menu) => {
        const entries = [...projected.railPins]
          .filter(([, element]) => element.isConnected)
          .toSorted(([, left], [, right]) =>
            left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
          )
          .map(([entry]) => entry);
        const index = entries.indexOf(menu.entry);
        const before = index >= 0 ? entries[index - 1] : undefined;
        const after = index >= 0 ? entries[index + 1] : undefined;
        const trigger = projected.triggers.get("railPin");
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
          <Show when={view.sidebarEntries.includes(menu.entry)}>
            <SidebarDropdown
              position={menu}
              class="sidebar-customize-menu sidebar-rail-pin-menu"
              label={t("chat.sidebar.reorderItem", { item: menu.label })}
              {...projected.positionedMenuHandlers("railPin")}
              onSelect={(value) => {
                projected.closePositionedMenu("railPin");
                if (value === "remove") {
                  view.sessionOrganizer.removeSidebarEntry(menu.entry);
                } else if (value === "before" || value === "after") {
                  const target = value === "before" ? before : after;
                  if (target) {
                    view.sessionOrganizer.writeSidebarEntryAt(menu.entry, target, value);
                    void projected
                      .commit()
                      .then((committed) => committed && trigger?.isConnected && trigger.focus());
                  }
                }
              }}
              items={items()}
            />
          </Show>
        );
      }}
    </Show>,
    <Show when={projected.pluginNavigationMenuPosition} keyed>
      {(menu) => renderSidebarPluginNavigationMenuForMenus(projected, view, menu)}
    </Show>,
    <Show when={projected.agentMenuPosition} keyed>
      {(menu) =>
        agentMenuAvatars.withActiveRoutes(() => {
          const avatarReader = avatars.read;
          const avatarGateway = useAvatarGatewayContext();
          const trigger = projected.triggers.get("agent");
          const menuRef = projected.menuRef("agent");
          const chipAgent = createMemo(() => view.activeChipAgent());
          const agents = createMemo(() => {
            const source = view.sessionDataContext?.agents;
            return source && projectAgents(source);
          });
          const gateway = createMemo(() => {
            const source = view.sessionDataContext?.gateway;
            return source && projectGateway(source);
          });
          const preferences = createMemo(() => {
            const source = view.sessionDataContext?.theme;
            return source && projectTheme(source).preferences;
          });
          const creationDisabledReason = createMemo(() => {
            const snapshot = gateway()?.read().snapshot;
            if (canCallGatewayMethod(snapshot, "agents.create", "operator.admin")) {
              return null;
            }
            if (!snapshot?.client || snapshot.phase !== "connected" || !snapshot.hello) {
              return t("agentChip.creationRequiresConnection");
            }
            if (isGatewayMethodAdvertised(snapshot, "agents.create") !== true) {
              return t("agentChip.creationUnsupported");
            }
            return t("agentChip.creationRequiresAdmin");
          });
          return (
            <SidebarAgentMenu
              {...{
                position: menu,
                ref: menuRef,
                basePath: view.basePath,
                activeId: chipAgent().agent ? chipAgent().activeId : "",
                agents: chipAgent().agents,
                identities: chipAgent().identities,
                pendingAgent: agents()?.read().pendingAgent,
                recentlyCreatedAgentId:
                  agents()?.read().recentlyCreatedAgentId ??
                  preferences()?.read().sidebarRecentlyCreatedAgentId,
                rosterMode: view.sidebarAgentsMode === "roster" && !chipAgent().pending,
                creationDisabledReason: creationDisabledReason(),
                onShowAllAgents: () => {
                  view.navigationView = "sessions";
                  view.sessionDataContext?.navigation.update({ navCollapsed: false });
                  patchSettings({ sidebarAgentsMode: "roster" });
                  view.sessionDataContext?.agentSelection.setScope(null);
                  view.onNavigate?.("sessions");
                  void projected.commit().then((committed) => {
                    if (!committed) {
                      return;
                    }
                    projected.focusAgentRoster?.();
                  });
                },
                resolveAvatarUrl: (url) => {
                  avatarGateway();
                  return avatarReader().resolve(url);
                },
                avatarErrorHandler: (url) => avatarReader().imageErrorHandler(url),
                openMode: projected.agentMenuMode,
                agentUnreadCount: (agentId) => view.agentUnreadCount(agentId),
                onPointerEnter: () => projected.handleAgentMenuPointerEnter(),
                onPointerLeave: () => projected.handleAgentMenuPointerLeave(),
                onAfterShow: () => projected.restoreFocusAfterAgentMenuHoverOpen(),
                onSwitchAgent: (agentId) => {
                  if (view.sidebarAgentsMode === "roster") {
                    patchSettings({ sidebarAgentsMode: "chip" });
                  }
                  view.switchChipAgent(agentId);
                },
                onCreateAgent: () => {
                  if (view.sessionDataContext) {
                    projected.closeAgentMenu();
                    projected.openAgentCreateDialog();
                  }
                },
                anchor: trigger ?? undefined,
                onClose: (restoreFocus) => {
                  if (projected.agentMenuPosition !== menu) {
                    return;
                  }
                  projected.closeAgentMenu({ restoreFocus });
                },
                onNavigate: (routeId, options) => view.onNavigate?.(routeId, options),
              }}
            />
          );
        })
      }
    </Show>,
    <Show when={projected.agentCreateDialogOpen}>
      {renderSidebarAgentCreateDialogForMenus(projected, view)}
    </Show>,
    <Show when={projected.identityMenuPosition} keyed>
      {(menu) => {
        const selfUser = () =>
          view.sessionDataContext
            ? gatewayPresentationScope(view.sessionDataContext.gateway).displayUser
            : null;
        const overlays = createMemo(() => {
          const source = view.sessionDataContext?.overlays;
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
              nativeGatewaySnapshot: view.nativeGatewaySnapshot,
              position: menu,
              canPairDevice: view.canPairDevice,
              basePath: view.basePath,
              gatewayVersion: view.gatewayVersion,
              updateAvailable: updateAvailable(),
              profileViewer: profileViewer(),
              canRetryConnection: canRetryGatewayStatus(view.connectionStatus),
              themeMode: view.themeMode,
              onThemeChange: (mode, element) =>
                view.sessionDataContext?.theme.setMode(mode, element),
              triggerWidth: menu.width,
              ...projected.positionedMenuHandlers("identity"),
              onNavigate: (routeId, options) => view.onNavigate?.(routeId, options),
              onPairMobile: () => view.onPairMobile?.(),
              onRetryConnect: view.onRetryConnect,
            }}
          />
        );
      }}
    </Show>,
    <Show when={projected.sessionMenu} keyed>
      {(menu) => {
        const context = () => view.sessionDataContext;
        const pluginActionSignal = () => projected.pluginActionLifetime.signal;
        const currentSession = () => view.findSidebarMenuSessionByKey(menu.session.key);
        // Read again at dispatch: session updates can arrive before the menu rerenders.
        const currentPluginSession = () =>
          view.sessionData.sessionsResult?.sessions.find(
            (row) => row.key === menu.session.key && row.sessionId === menu.session.sessionId,
          );
        const currentPlacementSession = () => {
          const row =
            findActiveSidebarLineageRow(view.sessionData, menu.session.key) ??
            currentPluginSession() ??
            Object.values(view.sessionData.sessionResultsByAgent)
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
            agentsList: view.sessionDataContext?.agents.state.agentsList,
            hello: view.sessionDataContext?.gateway.snapshot.hello,
          }),
        );
        const selection = createMemo(() => view.selectedVisibleSessions(), { equals: false });
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
          rows().every(
            (row) => row.unread || (row.subagentSummary?.unreadHiddenRuns?.length ?? 0) > 0,
          ),
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
          view.readSessionMutationAccess({
            method: "sessions.assignOwner",
            params: {
              key: session().key,
              owner: { type: "human", id: selfUser()?.id ?? "profile" },
            },
            requiredScope: "operator.write",
          }),
        );
        const actionDisabledReasons = createMemo(() => {
          const access = assignmentAccess();
          return {
            ...sessionMenuReasons({
              snapshot: context()?.gateway.snapshot,
              placementRow: currentPlacementSession(),
              requiredProfile:
                context()?.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
              session: session(),
              batchRows: batchRows(),
              cloudWorkerStopAction: session().cloudWorkerStopAction,
            }),
            ...(!access.allowed ? { "assign-owner": access.reason } : {}),
            ...(!view.connected ? { plugin: t("sessionsView.actionRequiresConnection") } : {}),
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
              pinned: view.sessionOrganizer.isPersonalSessionPin(session().key),
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
                rows().every((row) => categoryClearReturnsToGroups(row, view.sessionsGrouping)),
            }}
            involvingMeContext={view.sessionInvolvingMeFilterActive}
            selectionCount={rows().length}
            compact={isMobileNavLayout()}
            lastActive={batchRows() ? "" : formatSidebarTimestamp(session().updatedAt)}
            anchor={menu}
            trigger={projected.triggers.get("session") ?? null}
            disabled={false}
            actionDisabledReasons={actionDisabledReasons()}
            navigationAllowed={Boolean(context())}
            copyMarkdownAllowed={canCopySessionMarkdown(context()?.gateway.snapshot)}
            splitAllowed={canSplitSessionView()}
            forkDisabled={view.sessionData.sessionsLoading || session().modelSelectionLocked}
            forkFromLastCompleted={session().gatewayHasActiveRun ?? session().hasActiveRun}
            snoozeAllowed={true}
            archiveAllowed={archiveAllowed()}
            deleteAllowed={deleteAllowed()}
            cloudWorkerStopAllowed={cloudWorkerStopAllowed()}
            groups={view.knownSessionGroups()}
            currentOwner={session().owner?.actor ?? null}
            work={batchRows() ? null : projected.sessionMenuWork}
            pluginActions={
              !batchRows() && context()?.plugins && currentPluginSession()
                ? pluginSessionMenuActions(context()!.plugins, currentPluginSession()!)
                : []
            }
            onClose={() => {
              if (projected.sessionMenu === menu) {
                projected.closeSessionMenu();
              }
            }}
            onAction={(action: SessionMenuAction) => {
              const actionContext = context();
              const actionSignal = pluginActionSignal();
              const batch = batchRows();
              if (batch) {
                void runBatchSessionAction(view.sessionOrganizer, action, batch, allUnread());
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
                    const selectedAgentId = view.getSessionNavigationState().selectedAgentId;
                    void runSessionNavigationAction(action.kind, {
                      context: actionContext,
                      session: session(),
                      agentId: selectedAgentId,
                      isCurrent: () =>
                        view.sessionDataContext === actionContext &&
                        view.getSessionNavigationState().selectedAgentId === selectedAgentId,
                    });
                  }
                  break;
                case "move-session": {
                  const placementSession = currentPlacementSession();
                  const scopeGeneration = view.sessionData.sessionScopeGeneration;
                  if (actionContext && placementSession) {
                    void moveSessionFromMenu({
                      context: actionContext,
                      row: placementSession,
                      fallbackAgentId:
                        session().agentId ?? view.getSessionNavigationState().selectedAgentId,
                      currentRow: currentPlacementSession,
                      isCurrent: () =>
                        !actionSignal.aborted &&
                        view.sessionDataContext === actionContext &&
                        view.sessionData.sessionScopeGeneration === scopeGeneration,
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
                  void runSessionAction(view.sessionOrganizer, session(), action);
              }
            }}
          />
        );
      }}
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

function renderSidebarAgentCreateDialogForMenus(
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
          void import("../app/create-agent.ts")
            .then(({ createApplicationAgent }) => createApplicationAgent(context, identity))
            .catch((error: unknown) =>
              showToast({
                message: t("agentChip.creationFailed", { error: formatUiError(error) }),
                durationMs: 12_000,
              }),
            );
        }}
      />
    </Loading>
  );
}
