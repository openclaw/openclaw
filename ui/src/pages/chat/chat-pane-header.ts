import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import { isNativeLocalGateway } from "../../app/native-editor-locality.runtime.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-options.ts";
import { COMMAND_PALETTE_OPEN_EVENT } from "../../components/command-palette-contract.ts";
import { personActivityRouting } from "../../components/person-activity-link.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { i18n, t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  projectPresenceViewers,
  presenceMatchesProfile,
  projectPresencePayload,
} from "../../lib/presence-users.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import {
  canDeleteSessionRows,
  isNativeCatalogAdoptionSessionKey,
  isPinnableUiSessionRow,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import {
  canCopySessionMarkdown,
  canSplitSessionView,
} from "../../lib/sessions/session-menu-navigation.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import { resolveChatAgentIdentity } from "./chat-agent-id.ts";
import {
  canLoadChatBranches,
  displayedChatSessionBranches,
  getChatBranchesQueryState,
  loadChatBranches,
} from "./chat-history-branches.ts";
import { createChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import { projectChatMobilePeople } from "./chat-mobile-people.ts";
import { ChatPaneDiscussion } from "./chat-pane-discussion.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import { buildHeaderPanelActions } from "./chat-pane-header-panel-actions.ts";
import { ChatPaneNativeSessionActions } from "./chat-pane-native-session-actions.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { projectSubagentStatus } from "./chat-subagent-wait.ts";
import { isChatRunWorking } from "./components/chat-composer.tsx";
import type { ChatDetails, ChatDetailsViewProps } from "./components/chat-details.tsx";
import type { HeaderPanelAction } from "./components/chat-header-panel-actions.tsx";
import "./components/chat-header-session-menu.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";
import {
  canRevealSessionWorkspace,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspaceIcon,
} from "./components/chat-pane-header-identity.tsx";
import type {
  ChatPaneHeaderPresentation,
  ChatPaneHeaderProps,
} from "./components/chat-pane-header.types.ts";
import { canManageChatSessionSharing } from "./components/chat-session-sharing.solid.tsx";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { isSidebarSlotVisible, type SidebarLayout, type SidebarSlotId } from "./sidebar-layout.ts";

type PaneControls = Pick<
  ReturnType<typeof createChatPaneRails>,
  "openPanelSlot" | "closePanelSlot"
>;

export abstract class ChatPaneHeader extends ChatPaneDiscussion {
  private readonly headerPeopleMentions = createChatMobilePeopleMentions(
    this.getHumanMentionAccess,
  );
  protected readonly headerDetailsRef: { value?: ChatDetails } = {};
  private headerMenuRow?: GatewaySessionRow;
  private headerWorkspace?: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
  private headerAgentWorkspace?: string;
  private headerWorkspaceGit = false;
  private headerPanelControls?: PaneControls;
  private headerBoardMenu?: BoardWidgetPageMenu;
  private readonly headerPanelsMemo = new ChatPaneHeaderMemo<HeaderPanelAction[]>();
  private readonly headerSessionActions = new ChatPaneNativeSessionActions();
  private readonly headerReasonsMemo = new ChatPaneHeaderMemo<
    Partial<Record<HeaderMenuActionKind, string>>
  >();
  private readonly headerMachineNameMemo = new ChatPaneHeaderMemo<
    (() => Promise<string | undefined>) | undefined
  >();
  private readonly headerGroupsMemo = new ChatPaneHeaderMemo<string[]>();
  private readonly headerActivityMemo = new ChatPaneHeaderMemo<
    ReturnType<typeof personActivityRouting>
  >();
  private readonly headerPeopleMemo = new ChatPaneHeaderMemo<
    ReturnType<typeof projectChatMobilePeople>
  >();
  private readonly headerViewersMemo = new ChatPaneHeaderMemo<
    ReturnType<typeof projectPresenceViewers>
  >();
  private readonly headerBoardMenuMemo = new ChatPaneHeaderMemo<BoardWidgetPageMenu | undefined>();
  private readonly onHeaderMenuOpen = () => {
    if (this.headerMenuRow) {
      void this.loadHeaderMenuData(
        this.headerMenuRow,
        this.headerAgentWorkspace,
        this.headerWorkspaceGit,
      );
    }
  };
  private readonly onHeaderDetails = (source: HTMLElement) => {
    if (
      this.state &&
      getChatBranchesQueryState(this.state).status === "idle" &&
      canLoadChatBranches(this.state)
    ) {
      void loadChatBranches(this.state);
    }
    this.headerDetailsRef.value?.open(source);
  };
  private readonly onHeaderCommandPalette = () =>
    window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
  private readonly onHeaderSettingsChange = (patch: Partial<UiSettings>) =>
    this.state?.applySettings(patch);
  private readonly onHeaderAction = (action: HeaderMenuAction) => {
    if (this.headerMenuRow) {
      void this.handleHeaderSessionAction(action, this.headerMenuRow);
    }
  };
  private readonly headerPanelCallbacks = {
    terminal: () => this.headerWorkspace?.onToggleTerminal?.(),
    browser: () => this.headerWorkspace?.onToggleBrowser?.(),
    desktop: () => this.headerWorkspace?.onToggleDesktop?.(),
    discussion: () => this.resolveSessionDiscussionAction()?.onToggle(),
    changes: () => this.headerWorkspace?.onOpenDiff?.(),
    files: () => this.headerWorkspace?.onToggleCollapsed(),
    companion: () => this.requestSessionRail("toggle"),
  };
  private readonly onHeaderBoardSelect = (value: string) => this.headerBoardMenu?.onSelect(value);

  protected renderPaneHeader(
    sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"],
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
    placementStartupStatus: ApplicationPlacementStartupStatus | null | undefined,
    sidebarLayout?: SidebarLayout,
    panelDefinitions = sidebarPanelDefinitions(),
    subagentStop?: ChatPaneHeaderProps["runAction"],
    detailsControl?: ChatDetailsViewProps,
    panelControls?: PaneControls,
  ): ChatPaneHeaderPresentation {
    const headerState = this.headerPresentation;
    this.headerPanelControls = panelControls;
    this.headerMenuRow = row;
    this.headerWorkspace = sessionWorkspace;
    this.headerAgentWorkspace = agentWorkspace;
    this.headerWorkspaceGit = workspaceGit;
    this.syncSelectedSessionSharing(row);
    const worktree = row?.worktree;
    const workspace = resolveSessionWorkspace({
      session: row,
      agentWorkspace: worktree ? undefined : agentWorkspace,
      worktreePath: worktree ? headerState.worktreePaths.get(worktree.id)?.path : undefined,
    });
    // Managed worktree sessions copy the worktree record's branch — the same
    // source the sidebar subtitle and preserved-worktree prompts use. Live
    // HEAD is only resolved for plain checkouts, where no record exists.
    // Cached HEAD is keyed by the resolved root and masked while the session
    // runs remotely, so reused keys, root transitions, open menus, and
    // in-flight lookups racing a dispatch can never surface a wrong branch.
    const rowRemote = Boolean(row?.execNode) || isCloudWorkerPlacementState(row?.placement?.state);
    const branch =
      row?.repository?.branch ||
      worktree?.branch ||
      (rowRemote || !workspace.root ? null : headerState.branches.get(workspace.root)?.value) ||
      null;
    const canReveal = canRevealSessionWorkspace({
      session: row,
      workspaceRoot: workspace.root,
      methodAdvertised:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "sessions.files.reveal") === true,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    });
    const branchSwitchWorking = this.state
      ? this.state.chatSending ||
        isChatRunWorking({
          runActive: hasDirectSessionRun(this.state),
          queue: this.state.chatQueue,
          runStatus: this.state.chatRunStatus,
          sessionKey: this.state.sessionKey,
        })
      : false;
    const branchSwitchAccess = readChatSessionActionAccess(
      this.context.gateway.snapshot,
      Boolean(this.state?.chatRunId),
    ).branchSwitch;
    const branchSwitchDisabledReason =
      this.state && this.isCurrentSessionArchived(this.state)
        ? t("chat.archivedSessionDisabled")
        : !branchSwitchAccess.allowed
          ? branchSwitchAccess.reason
          : branchSwitchWorking
            ? t("chat.sessionHeader.branchSwitchUnavailable")
            : null;
    const sharingSnapshot = this.context.gateway.snapshot;
    const renameAccess = row
      ? readSessionMethodAccess(this.context.gateway.snapshot, {
          method: "sessions.patch",
          params: { key: row.key, label: null },
          sessionScope: true,
          session: row,
          allowDeferred: true,
        })
      : null;
    const renameDisabledReason = !renameAccess
      ? t("sessionsView.actionRequiresConnection")
      : renameAccess.allowed
        ? undefined
        : renameAccess.reason;
    const configuredMainKey = resolveUiConfiguredMainKey({
      agentsList: this.context.agents.state.agentsList,
      hello: this.context.gateway.snapshot.hello,
    });
    const archiveAllowed = Boolean(row && this.canArchiveHeaderSession(row));
    const deleteAllowed = Boolean(
      row &&
      !isNativeCatalogAdoptionSessionKey(row.key) &&
      canDeleteSessionRows([row], configuredMainKey),
    );
    const pinnable = row != null && isPinnableUiSessionRow(row);
    const sessionActionDisabledReasons = row
      ? sessionMenuReasons({
          snapshot: this.context.gateway.snapshot,
          placementRow: row,
          requiredProfile:
            this.context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
          session: { ...row, pinnable },
        })
      : {};
    const assignmentAccess = row
      ? readSessionMethodAccess(this.context.gateway.snapshot, {
          method: "sessions.assignOwner",
          params: {
            key: row.key,
            owner: { type: "human", id: sharingSnapshot.selfUser?.id ?? "profile" },
          },
          requiredScope: "operator.write",
        })
      : null;
    const continueInTerminalDisabledReason = row
      ? this.continueInTerminalDisabledReason(row)
      : undefined;
    const actionDisabledReasons = this.headerReasonsMemo.read(
      [
        ...Object.entries(sessionActionDisabledReasons).flat(),
        assignmentAccess?.allowed,
        assignmentAccess && !assignmentAccess.allowed ? assignmentAccess.reason : undefined,
        continueInTerminalDisabledReason,
      ],
      () => ({
        ...sessionActionDisabledReasons,
        ...(assignmentAccess && !assignmentAccess.allowed
          ? { "assign-owner": assignmentAccess.reason }
          : {}),
        ...(continueInTerminalDisabledReason
          ? { "continue-in-terminal": continueInTerminalDisabledReason }
          : {}),
      }),
    );
    const desktopPanelAvailable =
      resolveChatPaneDesktopTarget(row) !== null &&
      isDesktopPanelAvailable(this.context.gateway.snapshot);
    const isPanelVisible = (slot: SidebarSlotId) => {
      const layout = this.state?.sidebarLayout;
      return Boolean(
        layout &&
        (this.usesMobileHost ? this.isSlotShown(layout, slot) : isSidebarSlotVisible(layout, slot)),
      );
    };
    const nativeDiscussion = this.resolveSessionDiscussionAction();
    const discussion =
      nativeDiscussion && this.usesMobileHost
        ? {
            active: isPanelVisible("discussion"),
            label: t(
              isPanelVisible("discussion")
                ? "chat.sessionDiscussion.hide"
                : "chat.sessionDiscussion.show",
            ),
            onToggle: () => {
              const admitted = this.resolveSessionDiscussionAction();
              if (!admitted) {
                return;
              }
              if (isPanelVisible("discussion")) {
                admitted.onToggle();
              } else {
                this.openSessionDiscussionSlot();
                this.navigateMobileHost({ area: "panels", slot: "discussion" });
              }
            },
          }
        : nativeDiscussion;
    const currentLayout = sidebarLayout ?? this.state?.sidebarLayout;
    const sidePanelOpen = currentLayout?.open === true && !currentLayout.expanded;
    const toggleSidePanel = () => this.setChatSidePanelOpen(!sidePanelOpen, sidebarLayout);
    const sessionRailVisible = isPanelVisible("companion");
    const subagentsVisible = isPanelVisible("subagents");
    const processesVisible = isPanelVisible("processes");
    const panelMenuActions = this.headerPanelsMemo.read(
      [
        Boolean(sessionWorkspace.onToggleTerminal),
        Boolean(sessionWorkspace.onToggleBrowser),
        desktopPanelAvailable && Boolean(sessionWorkspace.onToggleDesktop),
        discussion?.label,
        discussion?.active,
        Boolean(sessionWorkspace.onOpenDiff),
        sessionWorkspace.collapsed,
        sessionRailVisible,
        subagentsVisible,
        processesVisible,
        catalog,
        currentLayout,
        Boolean(panelControls),
        ...panelDefinitions.flatMap(({ slot, label, available }) => [slot, label, available]),
        i18n.getLocale(),
      ],
      () =>
        buildHeaderPanelActions({
          sessionWorkspace,
          callbacks: this.headerPanelCallbacks,
          desktopPanelAvailable,
          discussion,
          usesMobileHost: this.usesMobileHost,
          sessionRailVisible,
          subagentsVisible,
          processesVisible,
          catalog,
          currentLayout,
          panelDefinitions,
          panelControlsAvailable: Boolean(panelControls),
          isPanelVisible,
          readPanelControls: () => this.headerPanelControls,
          requestBackgroundPanel: (slot) => this.requestBackgroundPanel(slot, "toggle"),
        }),
    );
    // Mobile projects panel geometry; shared defaults use the retained owner layout.
    const defaultAction =
      !catalog && this.dashboardDefaultMenuAction(row, this.state?.sidebarLayout);
    const layoutMenuActions: HeaderMenuQuickAction[] = defaultAction
      ? [{ id: "dashboard-default", icon: "check", ...defaultAction }]
      : [];
    const placement = resolveChatPanePlacement({
      gatewaySnapshot: this.context.gateway.snapshot,
      requiredProfile: this.context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
      movingKey: headerState.placementMovingKey,
      reclaimingKey: headerState.placementReclaimingKey,
      restartingKey: headerState.placementRestartingKey,
      row,
    });
    const key = this.state?.sessionKey ?? "";
    const result = this.state?.sessionsResult;
    const groups = this.context.sessions?.state?.groups;
    const sessions = this.context.sessions?.state?.result?.sessions;
    const knownGroups = this.headerGroupsMemo.read([groups, sessions], () =>
      collectKnownSessionGroups(groups ?? [], sessions ?? []),
    );
    const showOwnerChip = (result?.owners?.length ?? 0) >= 2 || (row?.participantCount ?? 0) > 0;
    const personActivity = this.headerActivityMemo.read([this.context, this.context.basePath], () =>
      personActivityRouting(this.context),
    );
    const renderedOwnerIdentity = showOwnerChip ? row?.owner?.actor.identity : undefined;
    const viewers = catalog
      ? undefined
      : this.headerViewersMemo.read(
          [
            this.presence.snapshot,
            sharingSnapshot.selfUser,
            sharingSnapshot.client?.instanceId,
            key,
            detailsControl,
            renderedOwnerIdentity,
            showOwnerChip ? row?.participants : undefined,
          ],
          () =>
            projectPresenceViewers(
              this.presence.snapshot,
              sharingSnapshot.selfUser,
              sharingSnapshot.client?.instanceId,
              key,
              detailsControl
                ? []
                : [
                    ...(renderedOwnerIdentity ? [renderedOwnerIdentity] : []),
                    ...(showOwnerChip
                      ? (row?.participants ?? []).map(({ identity }) => identity)
                      : []),
                  ],
            ),
        );
    const ownerViewing = projectPresencePayload(this.presence.snapshot).users.some(
      (user) =>
        presenceMatchesProfile(user, renderedOwnerIdentity) && user.watchedSessions.includes(key),
    );
    const sharing = this.prepareSessionSharing(row, {
      personActivity,
      ownerViewing,
      showOwner: showOwnerChip && !this.mergedChrome && !detailsControl,
    });
    this.headerBoardMenu = this.pageBoardWidgetMenu(currentLayout);
    const boardWidgetMenu = this.headerBoardMenuMemo.read(
      [this.headerBoardMenu?.widget, this.headerBoardMenu?.tabs, this.headerBoardMenu?.canMutate],
      () => this.headerBoardMenu && { ...this.headerBoardMenu, onSelect: this.onHeaderBoardSelect },
    );
    const parentSession = this.observedParentSessionRow();
    const onBranchSelect = (leafEntryId: string) => {
      const access = readChatSessionActionAccess(
        this.context.gateway.snapshot,
        Boolean(this.state?.chatRunId),
      ).branchSwitch;
      if (!access.allowed) {
        this.publishHeaderError(access.reason);
        return;
      }
      void this.switchToBranch(leafEntryId);
    };
    const runner = row?.placement?.state === "active" ? row.placement.runner : undefined;
    const readMachineName = this.headerMachineNameMemo.read(
      [
        this.context.gateway.snapshot.client,
        this.connectionGeneration,
        row?.key,
        runner?.deviceId,
        row?.agentRuntime?.id,
      ],
      () =>
        runner?.deviceId && this.context.gateway.snapshot.client
          ? async () => {
              const scope = this.captureConnectionScope();
              if (
                !scope ||
                !readSessionMethodAccess(scope.context.gateway.snapshot, {
                  method: "environments.list",
                  requiredScope: "operator.read",
                }).allowed
              ) {
                return undefined;
              }
              try {
                const { requestPlaceCatalog } = await import("../new-session/cloud-target.ts");
                const placeCatalog = await requestPlaceCatalog(scope.client, row?.agentRuntime?.id);
                if (!this.ownsHeaderOutcomeScope(scope)) {
                  return undefined;
                }
                return placeCatalog.environments.find(
                  (environment) => environment.id === `node:${runner.deviceId}`,
                )?.label;
              } catch (error) {
                this.publishHeaderError(error, scope.headerOutcomeOwner);
                return undefined;
              }
            }
          : undefined,
    );
    const title =
      (catalog ? this.history.catalogSession?.name?.trim() : undefined) ||
      this.resolveHeaderSessionTitle(row);
    const branchQuery = this.state ? getChatBranchesQueryState(this.state) : undefined;
    const mentionableUsers = this.headerPeopleMentions.read()?.result.users;
    const header: ChatPaneHeaderProps = {
      onHeaderRef: this.registerHeaderElement,
      paneId: this.paneId,
      presented: { owner: this.element, isPresented: () => this.presented },
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      navDrawerOpen: this.navDrawerOpen,
      gatewayStatus: this.gatewayStatus,
      title,
      titlePending: !catalog && !title ? true : undefined,
      agent:
        !catalog && this.state?.settings?.sidebarAgentsMode === "roster"
          ? resolveChatAgentIdentity(this.state, this.context)
          : undefined,
      session: row,
      showOwnerChip,
      ownerViewing,
      personActivity,
      catalog,
      catalogColor: this.history.catalogSession?.color,
      editing: Boolean(headerState.renameSession && headerState.renameSession.key === row?.key),
      renameValue: headerState.renameValue,
      workspaceRoot: workspace.root,
      workspaceLabel: workspace.label,
      workspaceIcon: resolveChatPaneWorkspaceIcon(
        this.context,
        workspace.root ? row?.key : undefined,
      ),
      parentSession: resolveChatPaneParentSession(row, parentSession ? [parentSession] : []),
      branch,
      branches: this.state ? displayedChatSessionBranches(this.state) : [],
      branchSwitchDisabledReason,
      mobileVersions:
        this.state && branchQuery && branchQuery.status !== "idle"
          ? {
              scopeKey: JSON.stringify([
                this.connectionGeneration,
                resolveChatAgentIdentity(this.state, this.context)?.id,
                key,
              ]),
              branches: displayedChatSessionBranches(this.state),
              query: branchQuery,
              branchSwitchDisabledReason,
              onBranchSelect,
              onRetry: canLoadChatBranches(this.state)
                ? () => {
                    if (this.state) {
                      void loadChatBranches(this.state);
                    }
                  }
                : undefined,
            }
          : undefined,
      platform: headerState.platform,
      canReveal,
      copiedAction: headerState.copiedAction,
      renameDisabledReason,
      actionsDisabled: this.state?.connected !== true,
      panelMenuActions,
      layoutMenuActions,
      dashboardWidgetMenu: boardWidgetMenu,
      runningSubagentCount: projectSubagentStatus(
        {
          ...this.projectChildRoster(this.resolveChatReadTarget()),
          selectedSession: row,
          messages: this.state?.chatMessages ?? [],
        },
        false,
      ).running,
      sidebarLayout: currentLayout,
      panelDefinitions,
      onLayoutChange: (layout, options) => this.state?.updateSidebarLayout(layout, options),
      onToggleSidePanel: toggleSidePanel,
      onCloseSidePanel: (slot) => panelControls?.closePanelSlot(slot),
      // Desktop retains the native Details trigger even when a panel occupies main.
      // Keep the layout's external-trigger signal below for the Show chat action.
      detailsControl:
        detailsControl && this.sessionPresentation === "desktop"
          ? { ...detailsControl, externalTrigger: false }
          : detailsControl,
      onOpenDetails: detailsControl ? this.onHeaderDetails : undefined,
      conversationVisible: detailsControl?.conversationVisible,
      onToggleConversation:
        currentLayout && detailsControl?.externalTrigger
          ? () => this.toggleConversationPanel(currentLayout)
          : undefined,
      runAction: subagentStop,
      mobilePeopleMentions: { ...this.headerPeopleMentions },
      mobilePeople: row
        ? this.headerPeopleMemo.read([row, this.presence.snapshot, key, mentionableUsers], () =>
            projectChatMobilePeople({
              session: row,
              sessionKey: key,
              viewers: projectPresencePayload(this.presence.snapshot).users,
              mentionableUsers: mentionableUsers ?? [],
            }),
          )
        : undefined,
      mobileSharing: sharing,
      onOpenDashboard:
        this.mergedChrome && this.resolveBoardView().hasBoard && this.isBoardPanelAvailable()
          ? () => {
              this.showDashboard(false);
              this.navigateMobileHost({ area: "panels", slot: "dashboard" });
            }
          : undefined,
      presence: viewers?.length ? { staticUsers: viewers, personActivity } : undefined,
      sharingControl:
        sharing &&
        (canManageChatSessionSharing(sharing.session)
          ? !this.narrow && !sharing.openDisabledReason
          : sharing.session.visibility === "draft")
          ? sharing
          : undefined,
      publicAccessIndicator: this.narrow ? (sharing ?? undefined) : undefined,
      readMachineName,
      onMobilePlacementStop: row
        ? (name) => this.changeHeaderPlacement(row, "reclaim", undefined, name)
        : undefined,
      onMobilePlacementMove: row
        ? (presentation) => this.changeHeaderPlacement(row, "move", presentation)
        : undefined,
      placementControl: {
        session: row,
        placementStartupStatus,
        placementMoving: placement.moving,
        placementRestarting: placement.restarting,
        placementMoveDisabledReason: placement.moveDisabledReason,
        placementReclaimDisabledReason: placement.reclaimDisabledReason,
        placementRecoveryDisabledReason: placement.recoveryDisabledReason,
        onPlacementMove: () => row && void this.changeHeaderPlacement(row, "move"),
        onPlacementReclaim: () => row && void this.changeHeaderPlacement(row, "reclaim"),
        onPlacementRecover: () => row && void this.changeHeaderPlacement(row, "recover"),
      },
      sessionMenuAction:
        row && this.state?.connected
          ? {
              session: this.headerSessionMenuData(row, pinnable),
              worktreePath:
                row.execNode || !isNativeLocalGateway() ? null : (workspace.root ?? null),
              onboarding: this.onboarding,
              preferencesBrowserOnly:
                this.context.runtimeConfig?.state.connected &&
                this.context.runtimeConfig.canPatch === false,
              compact: this.narrow,
              mobile: this.mergedChrome,
              prewarm:
                this.presented &&
                this.state.connected &&
                !this.state.chatLoading &&
                (!this.boardProviderLease || this.boardProviderLease.provider.hasLoadedSnapshot),
              copyMarkdownAllowed: canCopySessionMarkdown(this.context.gateway.snapshot),
              splitAllowed: canSplitSessionView(),
              settings: this.state.settings,
              bubbleModeEnabled: this.context.config.current.chatBubblesEnabled === true,
              mainKey: resolveUiConfiguredMainKey({
                agentsList: this.context.agents.state.agentsList,
                hello: this.context.gateway.snapshot.hello,
              }),
              boardWidgetMenu:
                this.sessionPresentation === "desktop" && !this.compact && !this.onBackToSubagents
                  ? undefined
                  : boardWidgetMenu,
              sessionActions: this.headerSessionActions.read(
                this.context,
                row,
                placement.reclaimDisabledReason,
                this.onHeaderAction,
              ),
              sharing: sharing ?? null,
              groups: knownGroups,
              currentOwner: row.owner?.actor ?? null,
              actionDisabledReasons,
              forkDisabled: this.state.sessionsLoading || row.modelSelectionLocked === true,
              forkFromLastCompleted: row.hasActiveRun === true,
              archiveAllowed,
              archiveShortcut: this.active && this.presented && !this.onboarding,
              deleteAllowed,
              onOpen: this.onHeaderMenuOpen,
              onOpenCommandPalette: this.onHeaderCommandPalette,
              onOpenDetails: detailsControl === undefined ? undefined : this.onHeaderDetails,
              onSettingsChange: this.onHeaderSettingsChange,
              onAction: this.onHeaderAction,
            }
          : undefined,
      onBeginRename: () => row && this.beginHeaderRename(row),
      onRenameInput: (value) => {
        headerState.renameValue = value;
      },
      onCommitRename: () => this.commitHeaderRename(),
      onCancelRename: () => this.cancelHeaderRename(),
      onMenuOpenChange: (open) => {
        if (open && row) {
          void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
        }
      },
      onMenuAction: (action) =>
        row && this.handleHeaderMenuAction(action, row, workspace.root, branch),
      onOpenParentSession: (sessionKey) => this.onPaneSessionChange?.(this.paneId, sessionKey),
      onOpenAgentSettings: (agentId) =>
        this.context.navigate("agents", {
          pathname: pathForAgentPanel(agentId, null, this.context.basePath),
        }),
      onBranchSelect,
      onOpenSplitView: this.onOpenSplitView,
      onSplitDown: this.onSplitDown,
      onSplitRight: this.onSplitRight,
      onClosePane: this.onClosePane,
    };
    const continueCommand = this.currentContinueInTerminalCommand(row);
    return {
      header,
      continueInTerminal: continueCommand
        ? {
            command: continueCommand,
            onClose: () => this.closeContinueInTerminalDialog(),
          }
        : undefined,
    };
  }
}
