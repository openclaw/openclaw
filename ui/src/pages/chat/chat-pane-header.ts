import { html, nothing, type TemplateResult } from "lit";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { GatewaySessionRow, SessionVisibility } from "../../api/types.ts";
import { isNativeLocalGateway } from "../../app/native-editor-locality.runtime.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-render.ts";
import { COMMAND_PALETTE_OPEN_EVENT } from "../../components/command-palette-contract.ts";
import { icons } from "../../components/icons.ts";
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
  isPinnableUiSessionRow,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import {
  canCopySessionMarkdown,
  canSplitSessionView,
} from "../../lib/sessions/session-menu-navigation.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import { displayedChatSessionBranches } from "./chat-history-branches.ts";
import { ChatPaneDiscussion } from "./chat-pane-discussion.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import { ChatPaneNativeSessionActions } from "./chat-pane-native-session-actions.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { isChatRunWorking } from "./components/chat-composer.ts";
import "./components/chat-header-session-menu.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  renderChatPanePanelToggle,
  renderChatPanePanelLayoutActions,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspaceIcon,
} from "./components/chat-pane-header.ts";
import { renderChatPanePlacement } from "./components/chat-pane-placement.ts";
import {
  canManageChatSessionSharing,
  renderChatSessionPublicIndicator,
  renderChatSessionSharing,
  type ChatSessionSharingProps,
} from "./components/chat-session-sharing.ts";
import { renderContinueInTerminalDialog } from "./components/continue-in-terminal-dialog.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { isSidebarSlotVisible, type SidebarLayout } from "./sidebar-layout.ts";

export abstract class ChatPaneHeader extends ChatPaneDiscussion {
  private headerMenuRow?: GatewaySessionRow;
  private headerWorkspace?: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
  private headerAgentWorkspace?: string;
  private headerWorkspaceGit = false;
  private headerDefaultAction?: HeaderMenuQuickAction;
  private headerBoardMenu?: BoardWidgetPageMenu;
  private readonly headerPanelsMemo = new ChatPaneHeaderMemo<HeaderMenuQuickAction[]>();
  private readonly headerLayoutMemo = new ChatPaneHeaderMemo<HeaderMenuQuickAction[]>();
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
    subagents: () => this.requestSubagentsPanel("toggle"),
    processes: () => this.requestBackgroundPanel("processes", "toggle"),
  };
  private readonly onHeaderDefault = () => {
    if (this.headerDefaultAction?.kind !== "status") {
      this.headerDefaultAction?.onActivate();
    }
  };
  private readonly onHeaderSplitView = () => this.onOpenSplitView?.();
  private readonly onHeaderSplitDown = () => this.onSplitDown?.(this.paneId);
  private readonly onHeaderSplitRight = () => this.onSplitRight?.(this.paneId);
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
    subagentStop: TemplateResult | typeof nothing = nothing,
  ) {
    this.headerMenuRow = row;
    this.headerWorkspace = sessionWorkspace;
    this.headerAgentWorkspace = agentWorkspace;
    this.headerWorkspaceGit = workspaceGit;
    this.syncSelectedSessionSharing(row);
    const workspace = resolveSessionWorkspace({
      session: row,
      agentWorkspace: row?.worktree ? undefined : agentWorkspace,
      worktreePath: row?.worktree ? this.headerWorktreePaths.get(row.worktree.id)?.path : undefined,
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
      row?.worktree?.branch ||
      (rowRemote || !workspace.root ? null : this.headerBranches.get(workspace.root)?.value) ||
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
    const sharingWriteAccess = (method: string) =>
      readSessionMethodAccess(sharingSnapshot, { method, requiredScope: "operator.write" });
    const sharingVisibilityAccess = sharingWriteAccess("session.visibility.set");
    const publicShareAccess = sharingWriteAccess("session.publicShare.set");
    const sharingMemberAddAccess = sharingWriteAccess("session.members.add");
    const sharingMemberRemoveAccess = sharingWriteAccess("session.members.remove");
    const sharingOpenDisabledReason =
      sharingReadAccess.allowed || sharingVisibilityAccess.allowed
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
    const deleteAllowed = Boolean(row && canDeleteSessionRows([row], configuredMainKey));
    const pinnable = row != null && isPinnableUiSessionRow(row);
    const sessionActionDisabledReasons = row
      ? sessionMenuReasons({
          snapshot: this.context.gateway.snapshot,
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
    const desktopEnvironmentId = resolveChatPaneDesktopTarget(row);
    const desktopPanelAvailable =
      desktopEnvironmentId !== null && isDesktopPanelAvailable(this.context.gateway.snapshot);
    const discussion = this.resolveSessionDiscussionAction();
    const currentLayout = sidebarLayout ?? this.state?.sidebarLayout;
    const sidePanelOpen = currentLayout?.open === true && !currentLayout.expanded;
    const toggleSidePanel = () => this.setChatSidePanelOpen(!sidePanelOpen, sidebarLayout);
    const sidePanelAction = renderChatPanePanelToggle({
      label: t(sidePanelOpen ? "chat.sidePanel.minimize" : "chat.sidePanel.label"),
      icon: sidePanelOpen ? icons.panelRightClose : icons.panelRightOpen,
      className: "chat-side-panel-toggle",
      expanded: sidePanelOpen,
      onToggle: toggleSidePanel,
    });
    const browserPanelAction = sessionWorkspace.onToggleBrowser
      ? renderChatPanePanelToggle({
          label: t("browser.toggle"),
          icon: icons.globe,
          className: "chat-browser-panel-toggle",
          onToggle: sessionWorkspace.onToggleBrowser,
        })
      : nothing;
    const sessionRailVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "companion");
    const subagentsVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "subagents");
    const processesVisible =
      this.state !== undefined && isSidebarSlotVisible(this.state.sidebarLayout, "processes");
    const modifiedFiles =
      sessionWorkspace.list?.files.filter((file) => file.kind === "modified").length ?? 0;
    const panelMenuActions = this.headerPanelsMemo.read(
      [
        Boolean(sessionWorkspace.onToggleTerminal),
        Boolean(sessionWorkspace.onToggleBrowser),
        desktopPanelAvailable && Boolean(sessionWorkspace.onToggleDesktop),
        discussion?.label,
        discussion?.active,
        Boolean(sessionWorkspace.onOpenDiff),
        sessionWorkspace.collapsed,
        modifiedFiles,
        sessionRailVisible,
        subagentsVisible,
        processesVisible,
        catalog,
        i18n.getLocale(),
      ],
      () => {
        const callbacks = this.headerPanelCallbacks;
        const actions: HeaderMenuQuickAction[] = [];
        for (const [id, label, icon, onActivate] of [
          [
            "terminal",
            t("terminal.toggle"),
            icons.terminal,
            sessionWorkspace.onToggleTerminal && callbacks.terminal,
          ],
          [
            "browser",
            t("browser.toggle"),
            icons.globe,
            sessionWorkspace.onToggleBrowser && callbacks.browser,
          ],
          [
            "desktop",
            t("desktop.toggle"),
            icons.monitor,
            desktopPanelAvailable && sessionWorkspace.onToggleDesktop && callbacks.desktop,
          ],
          [
            "discussion",
            discussion?.label ?? "",
            icons.messageSquare,
            discussion && callbacks.discussion,
          ],
          [
            "changes",
            t("chat.sessionDiff.show"),
            icons.diff,
            sessionWorkspace.onOpenDiff && callbacks.changes,
          ],
        ] as const) {
          if (onActivate) {
            actions.push({
              id,
              label,
              icon,
              onActivate,
              ...(id === "discussion" ? { active: discussion?.active } : {}),
            });
          }
        }
        actions.push({
          id: "session-files",
          label: t(
            sessionWorkspace.collapsed
              ? "chat.workspaceFiles.showFiles"
              : "chat.workspaceFiles.collapse",
          ),
          icon: icons.fileText,
          active: !sessionWorkspace.collapsed,
          badge: modifiedFiles,
          onActivate: callbacks.files,
        });
        actions.push({
          id: "session-companion",
          label: t(sessionRailVisible ? "chat.rail.collapse" : "chat.rail.show"),
          icon: icons.spark,
          active: sessionRailVisible,
          onActivate: callbacks.companion,
        });
        if (!catalog) {
          for (const slot of ["subagents", "processes"] as const) {
            const subagents = slot === "subagents";
            actions.push({
              id: `session-${slot}`,
              label: t(subagents ? "chat.subagentsPanel.title" : "chat.processesPanel.title"),
              icon: subagents ? icons.bot : icons.terminal,
              active: subagents ? subagentsVisible : processesVisible,
              onActivate: callbacks[slot],
            });
          }
        }
        return actions;
      },
    );
    const defaultAction = !catalog && this.dashboardDefaultMenuAction(row, currentLayout);
    this.headerDefaultAction = defaultAction
      ? { id: "dashboard-default", icon: icons.check, ...defaultAction }
      : undefined;
    const layoutMenuActions = this.headerLayoutMemo.read(
      [
        defaultAction && defaultAction.kind,
        defaultAction && defaultAction.label,
        defaultAction && defaultAction.description,
        defaultAction && defaultAction.disabled,
        Boolean(this.onOpenSplitView),
        this.narrow,
        Boolean(this.onSplitDown),
        Boolean(this.onSplitRight),
        i18n.getLocale(),
      ],
      () => {
        const actions: HeaderMenuQuickAction[] = [];
        if (defaultAction) {
          actions.push({
            id: "dashboard-default",
            icon: icons.check,
            ...defaultAction,
            ...(defaultAction.kind === "status" ? {} : { onActivate: this.onHeaderDefault }),
          });
        }
        if (this.onOpenSplitView) {
          actions.push({
            id: "open-split-view",
            label: t("chat.splitView.open"),
            icon: icons.columns2,
            onActivate: this.onHeaderSplitView,
          });
        }
        for (const [id, label, icon, callback] of [
          ["split-down", "chat.splitView.splitDown", icons.panelBottomOpen, "onSplitDown"],
          ["split-right", "chat.splitView.splitRight", icons.panelRightOpen, "onSplitRight"],
        ] as const) {
          if (!this.narrow && this[callback]) {
            actions.push({
              id,
              label: t(label),
              icon,
              onActivate:
                callback === "onSplitDown" ? this.onHeaderSplitDown : this.onHeaderSplitRight,
            });
          }
        }
        return actions;
      },
    );
    const placement = resolveChatPanePlacement({
      gatewaySnapshot: this.context.gateway.snapshot,
      movingKey: this.headerPlacementMovingKey,
      reclaimingKey: this.headerPlacementReclaimingKey,
      restartingKey: this.headerPlacementRestartingKey,
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
            this.presencePayload,
            sharingSnapshot.selfUser,
            sharingSnapshot.client?.instanceId,
            key,
            renderedOwnerIdentity,
            showOwnerChip ? row?.participants : undefined,
          ],
          () =>
            projectPresenceViewers(
              this.presencePayload,
              sharingSnapshot.selfUser,
              sharingSnapshot.client?.instanceId,
              key,
              [
                ...(renderedOwnerIdentity ? [renderedOwnerIdentity] : []),
                ...(showOwnerChip ? (row?.participants ?? []).map(({ identity }) => identity) : []),
              ],
            ),
        );
    const ownerViewing = projectPresencePayload(this.presencePayload).users.some(
      (user) =>
        presenceMatchesProfile(user, renderedOwnerIdentity) && user.watchedSessions.includes(key),
    );
    const sharingState = row
      ? this.sessionSharingStates.get(this.sessionSharingCacheKey(row.key))
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
        sharingVisibilityAccess.allowed,
        sharingVisibilityAccess.allowed ? undefined : sharingVisibilityAccess.reason,
        sharingMemberAddAccess.allowed,
        sharingMemberAddAccess.allowed ? undefined : sharingMemberAddAccess.reason,
        sharingMemberRemoveAccess.allowed,
        sharingMemberRemoveAccess.allowed ? undefined : sharingMemberRemoveAccess.reason,
        publicShareAccess.allowed,
        publicShareAccess.allowed ? undefined : publicShareAccess.reason,
        ownerViewing,
        personActivity,
        showOwnerChip,
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
              visibilityDisabledReason: sharingVisibilityAccess.allowed
                ? undefined
                : sharingVisibilityAccess.reason,
              memberAddDisabledReason: sharingMemberAddAccess.allowed
                ? undefined
                : sharingMemberAddAccess.reason,
              memberRemoveDisabledReason: sharingMemberRemoveAccess.allowed
                ? undefined
                : sharingMemberRemoveAccess.reason,
              publicShareDisabledReason:
                !row.sessionId || isIncognitoSessionKey(row.key)
                  ? t("chat.sessionSharing.publicUnavailable")
                  : publicShareAccess.allowed
                    ? undefined
                    : publicShareAccess.reason,
              onPublicShareChange: (enabled: boolean) =>
                void this.setSessionPublicShare(row, enabled),
              onCopyPublicLink: () => void this.copySessionPublicLink(row),
              ownerViewing,
              personActivity,
              showOwner: showOwnerChip,
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
    const header = renderChatPaneHeader({
      paneId: this.paneId,
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      navDrawerOpen: this.navDrawerOpen,
      title:
        (catalog ? this.catalogSession?.name?.trim() : undefined) ||
        this.resolveHeaderSessionTitle(row),
      session: row,
      showOwnerChip,
      ownerViewing,
      personActivity,
      catalog,
      catalogColor: this.catalogSession?.color,
      editing: this.headerEditing && this.headerRenameSession?.key === row?.key,
      renameValue: this.headerRenameValue,
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
      platform: this.headerPlatform,
      canReveal,
      copiedAction: this.headerCopiedAction,
      renameDisabledReason,
      actionsDisabled: this.state?.connected !== true,
      panelActions: browserPanelAction,
      runAction: subagentStop,
      panelLayoutActions: html`${renderChatPanePanelLayoutActions(
        currentLayout,
        panelDefinitions,
        this.narrow,
        (layout, options) => this.state?.updateSidebarLayout(layout, options),
      )}${sidePanelAction}`,
      presence: viewers?.length
        ? html`<openclaw-viewer-facepile
            class="chat-pane__presence"
            .staticUsers=${viewers}
            .maxVisible=${4}
            .personActivity=${personActivity}
            variant="session"
          ></openclaw-viewer-facepile>`
        : nothing,
      sharingControl:
        sharing &&
        (!canManageChatSessionSharing(sharing.session) || !sharing.openDisabledReason) &&
        (!this.narrow || !canManageChatSessionSharing(sharing.session))
          ? renderChatSessionSharing(sharing)
          : nothing,
      publicAccessIndicator:
        this.narrow && sharing ? renderChatSessionPublicIndicator(sharing) : nothing,
      placementControl: renderChatPanePlacement({
        session: row,
        placementStartupStatus,
        placementMoving: placement.moving,
        placementRestarting: placement.restarting,
        placementMoveDisabledReason: placement.moveDisabledReason,
        placementReclaimDisabledReason: placement.reclaimDisabledReason,
        placementRecoveryDisabledReason: placement.recoveryDisabledReason,
        onPlacementMove: () => row && void this.changeHeaderPlacement(row, "move"),
        onPlacementReclaim: () => row && void this.reclaimHeaderPlacement(row),
        onPlacementRecover: () => row && void this.changeHeaderPlacement(row, "recover"),
      }),
      sessionMenuAction:
        row && this.state
          ? html`<openclaw-chat-header-session-menu
              .session=${this.headerSessionMenuData(row, pinnable)}
              .worktreePath=${row.execNode || !isNativeLocalGateway() ? null : workspace.root}
              .onboarding=${this.onboarding}
              .preferencesBrowserOnly=${
                this.context.runtimeConfig?.state.connected &&
                this.context.runtimeConfig.canPatch === false
              }
              .compact=${this.narrow}
              .copyMarkdownAllowed=${canCopySessionMarkdown(this.context.gateway.snapshot)}
              .splitAllowed=${canSplitSessionView()}
              .settings=${this.state.settings}
              .panelActions=${panelMenuActions}
              .layoutActions=${layoutMenuActions}
              .boardWidgetMenu=${boardWidgetMenu}
              .sessionActions=${this.headerSessionActions.read(
                this.context,
                row,
                placement.reclaimDisabledReason,
                this.onHeaderAction,
              )}
              .sharing=${sharing}
              .groups=${knownGroups}
              .currentOwner=${row.owner?.actor ?? null}
              .actionDisabledReasons=${actionDisabledReasons}
              .forkDisabled=${this.state.sessionsLoading || row.modelSelectionLocked === true}
              .forkFromLastCompleted=${row.hasActiveRun === true}
              .archiveAllowed=${archiveAllowed}
              .archiveShortcut=${this.active && this.presented && !this.onboarding}
              .deleteAllowed=${deleteAllowed}
              .onOpen=${this.onHeaderMenuOpen}
              .onOpenCommandPalette=${this.onHeaderCommandPalette}
              .onSettingsChange=${this.onHeaderSettingsChange}
              .onAction=${this.onHeaderAction}
            ></openclaw-chat-header-session-menu>`
          : nothing,
      onBeginRename: () => row && this.beginHeaderRename(row),
      onRenameInput: (value) => {
        this.headerRenameValue = value;
      },
      onCommitRename: () => this.commitHeaderRename(),
      onCancelRename: () => this.cancelHeaderRename(),
      onMenuOpenChange: (open) => {
        if (open && row) {
          void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
        }
      },
      onMenuAction: (action) => {
        if (row) {
          this.handleHeaderMenuAction(action, row, workspace.root, branch);
        }
      },
      onOpenParentSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
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
    });
    const continueCommand = this.currentContinueInTerminalCommand(row);
    return html`${header}${
      continueCommand
        ? renderContinueInTerminalDialog({
            command: continueCommand,
            onClose: () => this.closeContinueInTerminalDialog(),
          })
        : nothing
    }`;
  }
}
