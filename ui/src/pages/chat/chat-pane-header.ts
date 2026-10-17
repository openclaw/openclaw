import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { GatewaySessionRow, SessionVisibility } from "../../api/types.ts";
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
import { displayedChatSessionBranches } from "./chat-history-branches.ts";
import { ChatPaneDiscussion } from "./chat-pane-discussion.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type { PaneDetailsProps } from "./chat-pane-header-view.tsx";
import { ChatPaneNativeSessionActions } from "./chat-pane-native-session-actions.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { projectSubagentStatus } from "./chat-subagent-wait.ts";
import { isChatRunWorking } from "./components/chat-composer.tsx";
import type { ChatDetails } from "./components/chat-details.tsx";
import type { HeaderPanelAction } from "./components/chat-header-panel-actions.tsx";
import "./components/chat-header-session-menu.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";
import {
  canRevealSessionWorkspace,
  type ChatPaneHeaderPresentation,
  type ChatPaneHeaderProps,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspaceIcon,
} from "./components/chat-pane-header.ts";
import {
  canManageChatSessionSharing,
  type ChatSessionSharingProps,
} from "./components/chat-session-sharing.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { isSidebarSlotVisible, type SidebarLayout, type SidebarSlotId } from "./sidebar-layout.ts";

export abstract class ChatPaneHeader extends ChatPaneDiscussion {
  protected readonly headerDetailsRef: { value?: ChatDetails } = {};
  private headerMenuRow?: GatewaySessionRow;
  private headerWorkspace?: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
  private headerAgentWorkspace?: string;
  private headerWorkspaceGit = false;
  private headerPanelControls?: {
    openPanelSlot: (slot: SidebarSlotId) => void;
    closePanelSlot: (slot: SidebarSlotId) => void;
  };
  private headerBoardMenu?: BoardWidgetPageMenu;
  private readonly headerPanelsMemo = new ChatPaneHeaderMemo<HeaderPanelAction[]>();
  private readonly headerSessionActions = new ChatPaneNativeSessionActions();
  private readonly headerReasonsMemo = new ChatPaneHeaderMemo<
    Partial<Record<HeaderMenuActionKind, string>>
  >();
  private readonly headerSharingMemo = new ChatPaneHeaderMemo<
    (ChatSessionSharingProps & { session: GatewaySessionRow }) | null
  >();
  private readonly headerGroupsMemo = new ChatPaneHeaderMemo<string[]>();
  private readonly headerActivityMemo = new ChatPaneHeaderMemo<
    ReturnType<typeof personActivityRouting>
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
  private readonly onHeaderDetails = (source: HTMLElement) =>
    this.headerDetailsRef.value?.open(source);
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
    detailsControl?: PaneDetailsProps,
    panelControls?: {
      openPanelSlot: (slot: SidebarSlotId) => void;
      closePanelSlot: (slot: SidebarSlotId) => void;
    },
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
    const sharingMethodsSupported =
      isGatewayMethodAdvertised(sharingSnapshot, "session.visibility.set") === true;
    const sharingReadAccess = readSessionMethodAccess(sharingSnapshot, {
      method: "session.members.listEvidence",
      requiredScope: "operator.read",
    });
    const sharingWriteReason = (method: string) => {
      const access = readSessionMethodAccess(sharingSnapshot, {
        method,
        requiredScope: "operator.write",
      });
      return access.allowed ? undefined : access.reason;
    };
    const visibilityDisabledReason = sharingWriteReason("session.visibility.set");
    const publicShareDisabledReason = sharingWriteReason("session.publicShare.set");
    const memberAddDisabledReason = sharingWriteReason("session.members.add");
    const memberRemoveDisabledReason = sharingWriteReason("session.members.remove");
    const sharingOpenDisabledReason =
      sharingReadAccess.allowed || visibilityDisabledReason === undefined
        ? undefined
        : sharingReadAccess.reason;
    const renameAccess = row
      ? readSessionMethodAccess(this.context.gateway.snapshot, {
          method: "sessions.patch",
          params: { key: row.key, label: null },
          sessionScope: true,
          session: row,
        })
      : null;
    const renameDisabledReason =
      this.state?.connected !== true || !renameAccess
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
    const discussion = this.resolveSessionDiscussionAction();
    const currentLayout = sidebarLayout ?? this.state?.sidebarLayout;
    const sidePanelOpen = currentLayout?.open === true && !currentLayout.expanded;
    const toggleSidePanel = () => this.setChatSidePanelOpen(!sidePanelOpen, sidebarLayout);
    const sessionRailVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "companion");
    const subagentsVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "subagents");
    const processesVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "processes");
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
      () => {
        const callbacks = this.headerPanelCallbacks;
        const actions: HeaderPanelAction[] = [];
        const represented = new Set<SidebarSlotId>();
        const addPanelAction = (slot: SidebarSlotId | null, action: HeaderPanelAction) => {
          actions.push({
            ...action,
            shortcut: panelDefinitions.find((definition) => definition.slot === slot)?.shortcut,
          });
          if (slot) {
            represented.add(slot);
          }
        };
        for (const [id, label, icon, onActivate] of [
          [
            "terminal",
            t("terminal.toggle"),
            "terminal",
            sessionWorkspace.onToggleTerminal && callbacks.terminal,
          ],
          [
            "browser",
            t("browser.toggle"),
            "globe",
            sessionWorkspace.onToggleBrowser && callbacks.browser,
          ],
          [
            "desktop",
            t("desktop.toggle"),
            "monitor",
            desktopPanelAvailable && sessionWorkspace.onToggleDesktop && callbacks.desktop,
          ],
          [
            "discussion",
            discussion?.label ?? "",
            "messageSquare",
            discussion && callbacks.discussion,
          ],
          [
            "changes",
            t("chat.sessionDiff.show"),
            "diff",
            sessionWorkspace.onOpenDiff && callbacks.changes,
          ],
        ] as const) {
          if (onActivate) {
            addPanelAction(id === "changes" ? null : id, {
              id,
              label,
              icon,
              onActivate,
              ...(id === "discussion" ? { active: discussion?.active } : {}),
            });
          }
        }
        addPanelAction("workspace", {
          id: "session-files",
          label: t(
            sessionWorkspace.collapsed
              ? "chat.workspaceFiles.showFiles"
              : "chat.workspaceFiles.collapse",
          ),
          icon: "fileText",
          active: !sessionWorkspace.collapsed,
          onActivate: callbacks.files,
        });
        addPanelAction("companion", {
          id: "session-companion",
          label: t(sessionRailVisible ? "chat.rail.collapse" : "chat.rail.show"),
          icon: "spark",
          active: sessionRailVisible,
          onActivate: callbacks.companion,
        });
        if (!catalog) {
          for (const slot of ["subagents", "processes"] as const) {
            const subagents = slot === "subagents";
            addPanelAction(slot, {
              id: `session-${slot}`,
              label: t(subagents ? "chat.subagentsPanel.title" : "chat.processesPanel.title"),
              icon: subagents ? "bot" : "terminal",
              active: subagents ? subagentsVisible : processesVisible,
              onActivate: () =>
                this.requestBackgroundPanel(
                  slot,
                  (subagents ? subagentsVisible : processesVisible) ? "close" : "open",
                ),
            });
          }
        }
        for (const definition of panelDefinitions) {
          if (
            !panelControls ||
            !definition.available ||
            represented.has(definition.slot) ||
            definition.slot === "conversation"
          ) {
            continue;
          }
          const slot = definition.slot;
          addPanelAction(slot, {
            id: `panel-${slot}`,
            label: definition.label,
            icon: definition.icon,
            active: Boolean(currentLayout && isSidebarSlotVisible(currentLayout, slot)),
            onActivate: () => {
              if (this.state && isSidebarSlotVisible(this.state.sidebarLayout, slot)) {
                this.headerPanelControls?.closePanelSlot(slot);
              } else {
                this.headerPanelControls?.openPanelSlot(slot);
              }
            },
          });
        }
        return actions;
      },
    );
    const defaultAction = !catalog && this.dashboardDefaultMenuAction(row, currentLayout);
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
            renderedOwnerIdentity,
            showOwnerChip ? row?.participants : undefined,
          ],
          () =>
            projectPresenceViewers(
              this.presence.snapshot,
              sharingSnapshot.selfUser,
              sharingSnapshot.client?.instanceId,
              key,
              [
                ...(renderedOwnerIdentity ? [renderedOwnerIdentity] : []),
                ...(showOwnerChip ? (row?.participants ?? []).map(({ identity }) => identity) : []),
              ],
            ),
        );
    const ownerViewing = projectPresencePayload(this.presence.snapshot).users.some(
      (user) =>
        presenceMatchesProfile(user, renderedOwnerIdentity) && user.watchedSessions.includes(key),
    );
    const sharingState = row
      ? this.collaboration.sharingStates.get(this.sessionSharingCacheKey(row.key))
      : undefined;
    const allowedVisibilities = sharingSnapshot.hello?.policy?.allowedSessionVisibilities;
    const sharing = this.headerSharingMemo.read(
      [
        sharingMethodsSupported,
        ...(row ? Object.entries(row).flat() : [undefined]),
        sharingState,
        allowedVisibilities,
        sharingReadAccess.allowed,
        sharingOpenDisabledReason,
        visibilityDisabledReason,
        memberAddDisabledReason,
        memberRemoveDisabledReason,
        publicShareDisabledReason,
        ownerViewing,
        personActivity,
        showOwnerChip,
        this.mergedChrome,
        i18n.getLocale(),
      ],
      () =>
        sharingMethodsSupported && row
          ? {
              session: row,
              state: sharingState,
              allowedVisibilities,
              membersAvailable: sharingReadAccess.allowed,
              openDisabledReason: sharingOpenDisabledReason,
              visibilityDisabledReason,
              memberAddDisabledReason,
              memberRemoveDisabledReason,
              publicShareDisabledReason:
                !row.sessionId || isIncognitoSessionKey(row.key)
                  ? t("chat.sessionSharing.publicUnavailable")
                  : publicShareDisabledReason,
              onPublicShareChange: (enabled: boolean) =>
                void this.setSessionPublicShare(row, enabled),
              onCopyPublicLink: () => void this.copySessionPublicLink(row),
              ownerViewing,
              personActivity,
              showOwner: showOwnerChip && !this.mergedChrome,
              onOpen: () => void this.loadSessionSharing(row),
              onVisibilityChange: (visibility: SessionVisibility) =>
                void this.setSessionVisibility(row, visibility),
              onMemberChange: (identityId: string, member: boolean) =>
                void this.setSessionMember(row, identityId, member),
            }
          : null,
    );
    this.headerBoardMenu = this.pageBoardWidgetMenu(currentLayout);
    const boardWidgetMenu = this.headerBoardMenuMemo.read(
      [this.headerBoardMenu?.widget, this.headerBoardMenu?.tabs, this.headerBoardMenu?.canMutate],
      () => this.headerBoardMenu && { ...this.headerBoardMenu, onSelect: this.onHeaderBoardSelect },
    );
    const parentSession = this.observedParentSessionRow();
    const header: ChatPaneHeaderProps = {
      paneId: this.paneId,
      presented: { owner: this.element, isPresented: () => this.presented },
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      navDrawerOpen: this.navDrawerOpen,
      title:
        (catalog ? this.history.catalogSession?.name?.trim() : undefined) ||
        this.resolveHeaderSessionTitle(row),
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
      platform: headerState.platform,
      canReveal,
      copiedAction: headerState.copiedAction,
      renameDisabledReason,
      actionsDisabled: this.state?.connected !== true,
      panelMenuActions,
      layoutMenuActions,
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
      detailsControl,
      onOpenDetails: detailsControl ? this.onHeaderDetails : undefined,
      conversationVisible: detailsControl?.conversationVisible,
      onToggleConversation:
        currentLayout && detailsControl?.externalTrigger
          ? () => this.toggleConversationPanel(currentLayout)
          : undefined,
      runAction: subagentStop,
      presence: viewers?.length ? { staticUsers: viewers, personActivity } : undefined,
      sharingControl:
        sharing &&
        (canManageChatSessionSharing(sharing.session)
          ? !this.narrow && !sharing.openDisabledReason
          : sharing.session.visibility === "draft")
          ? sharing
          : undefined,
      publicAccessIndicator: this.narrow ? (sharing ?? undefined) : undefined,
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
        row && this.state
          ? {
              session: this.headerSessionMenuData(row, pinnable),
              worktreePath:
                row.execNode || !isNativeLocalGateway() ? null : (workspace.root ?? null),
              onboarding: this.onboarding,
              preferencesBrowserOnly:
                this.context.runtimeConfig?.state.connected &&
                this.context.runtimeConfig.canPatch === false,
              compact: this.narrow,
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
              boardWidgetMenu,
              sessionActions: this.headerSessionActions.read(
                this.context,
                row,
                placement.reclaimDisabledReason,
                this.onHeaderAction,
              ),
              sharing,
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
      onBranchSelect: (leafEntryId) => {
        const access = readChatSessionActionAccess(
          this.context.gateway.snapshot,
          Boolean(this.state?.chatRunId),
        ).branchSwitch;
        if (!access.allowed) {
          this.publishHeaderError(access.reason);
          return;
        }
        void this.switchToBranch(leafEntryId);
      },
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
