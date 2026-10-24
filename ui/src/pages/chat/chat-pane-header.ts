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
import { i18n, t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import {
  canCopySessionMarkdown,
  canSplitSessionView,
} from "../../lib/sessions/session-menu-navigation.ts";
import { resolveChatAgentIdentity } from "./chat-agent-id.ts";
import {
  canLoadChatBranches,
  displayedChatSessionBranches,
  getChatBranchesQueryState,
  loadChatBranches,
} from "./chat-history-branches.ts";
import { createChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import { ChatPaneDiscussion } from "./chat-pane-discussion.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { readChatPaneHeaderAccess } from "./chat-pane-header-access.ts";
import {
  resolveChatPaneParentSession,
  resolveChatPaneWorkspaceIcon,
  resolveChatPaneWorkspace,
} from "./chat-pane-header-identity.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import { ChatPaneHeaderPeople } from "./chat-pane-header-people.ts";
import { ChatPaneNativeSessionActions } from "./chat-pane-native-session-actions.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import { isChatRunWorking } from "./chat-run-working.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import "./components/chat-header-session-menu.ts";
import { countRunningSubagents } from "./chat-subagent-wait.ts";
import type { ChatDetails, ChatDetailsViewProps } from "./components/chat-details.tsx";
import type { HeaderPanelAction } from "./components/chat-header-panel-actions.tsx";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";
import type {
  ChatPaneHeaderPresentation,
  ChatPaneHeaderProps,
} from "./components/chat-pane-header.types.ts";
import { canManageChatSessionSharing } from "./components/chat-session-sharing-shared.tsx";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import {
  isSidebarSlotVisible,
  sidebarMainPanel,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

registerChatSessionEnglish();

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
  private readonly headerPeople = new ChatPaneHeaderPeople();
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
    discussion: () => {
      const discussion = this.resolveSessionDiscussionAction();
      if (!discussion) {
        return;
      }
      // Cached menu actions follow the pane's current desktop/mobile presentation.
      if (
        this.usesMobileHost &&
        this.state &&
        !this.isSlotShown(this.state.sidebarLayout, "discussion")
      ) {
        this.openSessionDiscussionSlot();
        this.navigateMobileHost({ area: "panels", slot: "discussion" });
      } else {
        discussion.onToggle();
      }
    },
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
    const workspace = resolveChatPaneWorkspace({
      session: row,
      agentWorkspace,
      worktreePaths: headerState.worktreePaths,
      branches: headerState.branches,
      methodAdvertised:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "sessions.files.reveal") === true,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    });
    const branch = workspace.branch;
    const branchSwitchWorking = this.state
      ? this.state.chatSending ||
        isChatRunWorking({
          runActive: hasDirectSessionRun(this.state),
          queue: this.state.chatQueue,
          runStatus: this.state.chatRunStatus,
          sessionKey: this.state.sessionKey,
        })
      : false;
    const sharingSnapshot = this.context.gateway.snapshot;
    const headerAccess = readChatPaneHeaderAccess({
      snapshot: sharingSnapshot,
      row,
      agentsList: this.context.agents.state.agentsList,
      hasLocalRun: Boolean(this.state?.chatRunId),
      working: branchSwitchWorking,
      archived: Boolean(this.state && this.isCurrentSessionArchived(this.state)),
      continueInTerminalDisabledReason: row
        ? this.continueInTerminalDisabledReason(row)
        : undefined,
    });
    const actionDisabledReasons = this.headerReasonsMemo.read(
      Object.entries(headerAccess.actionDisabledReasons).flat(),
      () => headerAccess.actionDisabledReasons,
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
      () => {
        const callbacks = this.headerPanelCallbacks;
        const panelControlsAvailable = Boolean(panelControls);
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
        if (
          panelDefinitions.some(
            (definition) => definition.slot === "companion" && definition.available,
          )
        ) {
          addPanelAction("companion", {
            id: "session-companion",
            label: t(sessionRailVisible ? "chat.rail.collapse" : "chat.rail.show"),
            icon: "spark",
            active: sessionRailVisible,
            onActivate: callbacks.companion,
          });
        }
        if (!catalog) {
          for (const slot of ["subagents", "processes"] as const) {
            const subagents = slot === "subagents";
            addPanelAction(slot, {
              id: `session-${slot}`,
              label: t(subagents ? "chat.subagentsPanel.title" : "chat.processesPanel.title"),
              icon: subagents ? "bot" : "terminal",
              active: subagents ? subagentsVisible : processesVisible,
              onActivate: () => this.requestBackgroundPanel(slot, "toggle"),
            });
          }
        }
        for (const definition of panelDefinitions) {
          if (
            !panelControlsAvailable ||
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
              if (isPanelVisible(slot)) {
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
    const groups = this.context.sessions?.state?.groups;
    const sessions = this.context.sessions?.state?.result?.sessions;
    const knownGroups = this.headerGroupsMemo.read([groups, sessions], () =>
      collectKnownSessionGroups(groups ?? [], sessions ?? []),
    );
    const personActivity = this.headerActivityMemo.read([this.context, this.context.basePath], () =>
      personActivityRouting(this.context),
    );
    const { showOwnerChip, viewers, ownerViewing, mobilePeople } = this.headerPeople.read({
      session: row,
      ownerCount: this.state?.sessionsResult?.owners?.length ?? 0,
      presence: this.presence.snapshot,
      selfUser: sharingSnapshot.selfUser,
      instanceId: sharingSnapshot.client?.instanceId,
      sessionKey: key,
      catalog,
      detailsControl,
      mentionableUsers: this.headerPeopleMentions.read()?.result.users,
    });
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
      workspaceIcon: resolveChatPaneWorkspaceIcon({
        sessionKey: workspace.root ? row?.key : undefined,
        resourceBasePath: this.context.resourceBasePath,
        hello: sharingSnapshot.hello,
        token: this.context.gateway.connection.token,
        password: this.context.gateway.connection.password,
      }),
      parentSession: resolveChatPaneParentSession(row, parentSession ? [parentSession] : []),
      branch,
      branches: this.state ? displayedChatSessionBranches(this.state) : [],
      branchSwitchDisabledReason: headerAccess.branchSwitchDisabledReason,
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
              branchSwitchDisabledReason: headerAccess.branchSwitchDisabledReason,
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
      canReveal: workspace.canReveal,
      copiedAction: headerState.copiedAction,
      renameDisabledReason: headerAccess.renameDisabledReason,
      actionsDisabled: this.state?.connected !== true,
      panelMenuActions,
      layoutMenuActions,
      dashboardWidgetMenu: boardWidgetMenu,
      runningSubagentCount: countRunningSubagents({
        ...this.projectChildRoster(this.resolveChatReadTarget()),
        selectedSession: row,
      }),
      sidebarLayout: currentLayout,
      panelDefinitions,
      onLayoutChange: (layout, options) => this.state?.updateSidebarLayout(layout, options),
      onToggleSidePanel: toggleSidePanel,
      onCloseSidePanel: (slot) => panelControls?.closePanelSlot(slot),
      // Desktop retains the native Details trigger even when a panel occupies main.
      // Other main panels retain their separate Show chat action below.
      detailsControl:
        detailsControl && this.sessionPresentation === "desktop"
          ? { ...detailsControl, externalTrigger: false }
          : detailsControl,
      onOpenDetails: detailsControl ? this.onHeaderDetails : undefined,
      conversationVisible: detailsControl?.conversationVisible,
      // Dashboard reveals its retained conversation through the frame's Panels control.
      onToggleConversation:
        currentLayout &&
        detailsControl?.externalTrigger &&
        sidebarMainPanel(currentLayout)?.slot !== "dashboard"
          ? () => this.toggleConversationPanel(currentLayout)
          : undefined,
      runAction: subagentStop,
      mobilePeopleMentions: { ...this.headerPeopleMentions },
      mobilePeople,
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
        row && this.state
          ? {
              session: this.headerSessionMenuData(row, headerAccess.pinnable),
              worktreePath:
                row.execNode || !isNativeLocalGateway() ? null : (workspace.root ?? null),
              onboarding: this.onboarding,
              preferencesBrowserOnly:
                this.context.runtimeConfig?.state.connected &&
                this.context.runtimeConfig.canPatch === false,
              compact: this.narrow,
              mobile: this.mergedChrome,
              copyMarkdownAllowed: canCopySessionMarkdown(this.context.gateway.snapshot),
              splitAllowed: canSplitSessionView(),
              settings: this.state.settings,
              bubbleModeEnabled: this.context.config.current.chatBubblesEnabled === true,
              mainKey: headerAccess.mainKey,
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
              archiveAllowed: this.canArchiveHeaderSession(row),
              archiveShortcut: this.active && this.presented && !this.onboarding,
              deleteAllowed: headerAccess.deleteAllowed,
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
