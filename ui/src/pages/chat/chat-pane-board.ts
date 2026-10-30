import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/server-capabilities.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  hasOperatorApprovalsAccess,
  hasOperatorReadAccess,
  hasOperatorSelfReadAccess,
} from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-options.ts";
import { t } from "../../i18n/index.ts";
import { BOARD_GRID_COLUMNS } from "../../lib/board/grid-constants.ts";
import {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  createNullBoardProvider,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import { updateBoardSessionView } from "../../lib/board/settings.ts";
import { currentDisplayConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import {
  readSessionMethodAccess,
  readSessionMethodScopeAccess,
} from "../../lib/session-method-access.ts";
import { resolveSessionKey } from "../../lib/sessions/navigation.ts";
import { resolveSessionPreferredFace } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  canonicalUiSessionKeyForPersistence,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { cacheChatBoardSnapshotAfterHydration } from "./chat-board-snapshot.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import type { ChatBoardPanelSource } from "./chat-pane-panel-source.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  fitSidebarLayout,
  initializeBrowserSidebarWidth,
  isSidebarSlotVisible,
  openDashboardPresentation,
  resizeSidebarPanel,
  sidebarDock,
  sidebarDashboardPresentation,
  type SidebarLayout,
} from "./sidebar-layout.ts";

export abstract class ChatPaneBoard extends ChatPaneHistory {
  boardView: HTMLElementTagNameMap["openclaw-board-view"] | null = null;
  private nullBoardProvider: { cacheKey: string; provider: BoardProvider } | undefined;
  readonly dashboardPresentation: { defaultWrite: { owner: string } | undefined } = {
    defaultWrite: undefined,
  };

  private get dashboardDefaultWriteOwner(): string {
    return JSON.stringify([
      this.headerOutcomeOwner,
      this.state?.sessionKey,
      this.resolveBoardConversation().agentId,
    ]);
  }

  private canSaveDashboardDefault(row: GatewaySessionRow): boolean {
    return Boolean(
      this.state?.connected &&
      row.sessionId &&
      !this.sessionParticipationTracker.resolve({
        catalog: false,
        listLoading: this.state.sessionsLoading,
        sessionKey: row.key,
        session: row,
      }) &&
      readSessionMethodAccess(this.context.gateway.snapshot, {
        method: "sessions.patch",
        params: { key: row.key, boardFace: "dashboard", boardPresentation: "split" },
      }).allowed,
    );
  }

  private isDashboardDefault(row: GatewaySessionRow, presentation: "split" | "expanded"): boolean {
    return (
      resolveSessionPreferredFace(row) === "dashboard" &&
      presentation === (row.boardPresentation ?? "split")
    );
  }

  protected dashboardDefaultMenuAction(
    row: GatewaySessionRow | undefined,
    layout: SidebarLayout | undefined,
  ) {
    const presentation = layout ? sidebarDashboardPresentation(layout) : undefined;
    if (!row?.sessionId || !this.state?.connected || !presentation) {
      return undefined;
    }
    const description = t("chat.sidePanel.defaultViewDescription");
    if (this.isDashboardDefault(row, presentation)) {
      return {
        kind: "status" as const,
        label: t("chat.sidePanel.currentViewIsDefault"),
        description,
      };
    }
    if (!this.canSaveDashboardDefault(row)) {
      return undefined;
    }
    const saving =
      this.dashboardPresentation.defaultWrite?.owner === this.dashboardDefaultWriteOwner;
    const agentId = this.resolveBoardConversation().agentId;
    return {
      label: t(saving ? "chat.sidePanel.savingDefault" : "chat.sidePanel.useViewAsDefault"),
      description,
      disabled: saving,
      onActivate: () => void this.saveDashboardDefault(row, agentId),
    };
  }

  protected async saveDashboardDefault(
    row: GatewaySessionRow,
    agentId: string | undefined,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = this.state ? selectedChatSessionRow(this.state) : undefined;
    const presentation = this.state
      ? sidebarDashboardPresentation(this.state.sidebarLayout)
      : undefined;
    if (
      !scope ||
      !currentRow ||
      currentRow.key !== row.key ||
      currentRow.sessionId !== row.sessionId ||
      this.resolveBoardConversation().agentId !== agentId ||
      !presentation ||
      !this.canSaveDashboardDefault(currentRow) ||
      this.isDashboardDefault(currentRow, presentation) ||
      this.dashboardPresentation.defaultWrite?.owner === this.dashboardDefaultWriteOwner
    ) {
      return;
    }
    const operation = { owner: this.dashboardDefaultWriteOwner };
    this.dashboardPresentation.defaultWrite = operation;
    const isCurrent = () =>
      this.ownsHeaderOutcomeScope(scope) &&
      this.dashboardPresentation.defaultWrite === operation &&
      this.context.sessions === scope.sessions &&
      this.dashboardDefaultWriteOwner === operation.owner &&
      selectedChatSessionRow(scope.state)?.sessionId === row.sessionId;
    try {
      const result = await scope.sessions.patch(
        row.key,
        { boardFace: "dashboard", boardPresentation: presentation },
        {
          agentId,
          expectedSessionId: row.sessionId,
        },
      );
      if (!isCurrent()) {
        return;
      }
      if (!result) {
        throw new Error(t("chat.sidePanel.defaultSaveFailed"));
      }
      // The session capability publishes the acknowledged metadata. Never turn
      // its value into a personal override or rearrange any active viewer.
      showToast({ message: t("chat.sidePanel.defaultSaved"), anchor: this.element });
    } catch (error) {
      if (isCurrent()) {
        this.publishHeaderError(error, scope.headerOutcomeOwner);
        showToast({
          message: t("chat.sidePanel.defaultSaveError", { error: formatUiError(error) }),
          anchor: this.element,
        });
      }
    } finally {
      if (this.dashboardPresentation.defaultWrite === operation) {
        this.dashboardPresentation.defaultWrite = undefined;
      }
    }
  }

  protected commitSidebarLayout(
    layout: SidebarLayout,
    options?: Parameters<ChatPageHost["updateSidebarLayout"]>[1],
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const initialized = this.initializeBrowserSidebarLayout(layout);
    state.updateSidebarLayout(this.fitPaneSidebarLayout(initialized), options);
  }

  private fitPaneSidebarLayout(layout: SidebarLayout): SidebarLayout {
    return this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
      ? (fitSidebarLayout(layout, this.paneWidth) ?? layout)
      : layout;
  }

  protected initializeBrowserSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!layout.columns[0]?.browserWidthPending || !isSidebarSlotVisible(layout, "browser")) {
      return layout;
    }
    const composer = this.composerShell;
    if (!composer?.isConnected) {
      return layout;
    }
    const inset = Number.parseFloat(
      getComputedStyle(composer).getPropertyValue("--chat-composer-side-inset"),
    );
    return initializeBrowserSidebarWidth(
      layout,
      this.sidebarRegionElement?.getBoundingClientRect().width ?? this.paneWidth,
      composer.getBoundingClientRect().width + (Number.isFinite(inset) ? inset : 0),
    );
  }

  protected commitSidebarPanelResize(
    renderedLayout: SidebarLayout,
    columnId: string,
    size: number,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const resizedProjection = resizeSidebarPanel(renderedLayout, columnId, size);
    const fittedProjection = this.fitPaneSidebarLayout(resizedProjection);
    const fittedColumn = fittedProjection.columns.find((column) => column.id === columnId);
    const fittedSize =
      sidebarDock(fittedProjection) === "bottom" ? fittedColumn?.height : fittedColumn?.width;
    if (
      fittedSize !== undefined &&
      state.sidebarLayout.columns.some((column) => column.id === columnId)
    ) {
      state.updateSidebarLayout(resizeSidebarPanel(state.sidebarLayout, columnId, fittedSize), {
        geometryOnly: true,
      });
      return;
    }
    this.commitSidebarLayout(fittedProjection, { geometryOnly: true });
  }

  protected resolveBoardConversation() {
    return resolveUiConversationIdentity(
      {
        assistantAgentId: this.state?.assistantAgentId,
        agentsList: this.state?.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      },
      this.state?.sessionKey || this.sessionKey,
    );
  }

  protected resolveBoardProvider(): BoardProvider {
    const session = this.resolveBoardConversation();
    if (this.boardProvider) {
      this.releaseBoardProviderLease();
      return this.boardProvider;
    }
    const gateway = this.context?.gateway.snapshot;
    const auth = gateway?.hello?.auth ?? null;
    const available =
      !gateway ||
      (hasOperatorSelfReadAccess(auth) &&
        isGatewayMethodAdvertised(gateway, "board.get") !== false);
    const canMutate =
      !auth?.scopes ||
      readSessionMethodScopeAccess(auth, {
        method: "board.update",
        requiredScope: "operator.sessions.write",
        session: this.state ? selectedChatSessionRow(this.state) : undefined,
      }).allowed;
    const canGrant = !gateway || hasOperatorApprovalsAccess(auth);
    const canPinWidgets =
      canMutate &&
      (!gateway ||
        isGatewayCapabilityAdvertised(gateway, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true);
    const canPinMcpApps =
      canMutate &&
      (!gateway ||
        (hasOperatorReadAccess(auth) &&
          isGatewayMethodAdvertised(gateway, "board.widget.appView") === true &&
          isGatewayMethodAdvertised(gateway, "board.widget.put") === true));
    const client = gateway?.client;
    if (this.boardProviderLifecycleConnected && client && available) {
      const presentationScope = gatewayPresentationScope(this.context.gateway);
      const key = JSON.stringify([presentationScope?.key, boardProviderCacheKey(session)]);
      if (this.boardProviderLease?.cacheKey !== key) {
        this.releaseBoardProviderLease();
        const state = this.state;
        const context = this.context;
        let active = true;
        const lease = acquireBoardProviderForSession(
          session,
          client,
          gateway.phase === "connected",
          canPinWidgets,
          canPinMcpApps,
          canMutate,
          canGrant,
          presentationScope,
          (snapshot, receivedAtMs) => {
            const currentState = this.state;
            if (!currentState) {
              return;
            }
            cacheChatBoardSnapshotAfterHydration(
              currentState,
              session,
              snapshot,
              receivedAtMs,
              () => active && gatewayPresentationScope(context.gateway) === presentationScope,
            );
          },
        );
        this.boardProviderLease = {
          ...lease,
          cacheKey: key,
          release: () => {
            active = false;
            lease.release();
          },
        };
        const cached =
          state && readChatSessionSnapshot(state.chatMessagesBySession, state, session);
        if (cached?.board) {
          this.boardProviderLease.restoreSnapshot(cached.board.snapshot, cached.board.receivedAtMs);
        }
      } else {
        this.boardProviderLease.update(client, gateway.phase === "connected", {
          canPinWidgets,
          canPinMcpApps,
          canMutate,
          canGrant,
        });
      }
      return this.boardProviderLease.provider;
    }
    this.releaseBoardProviderLease();
    const cached = boardProviderForSession(session, available);
    if (cached) {
      return cached;
    }
    const cacheKey = boardProviderCacheKey(session);
    if (this.nullBoardProvider?.cacheKey !== cacheKey) {
      const provider = createNullBoardProvider(session.sessionKey);
      this.nullBoardProvider = { cacheKey, provider };
    }
    return this.nullBoardProvider.provider;
  }

  protected releaseBoardProviderLease(): void {
    this.boardProviderLease?.release();
    this.boardProviderLease = undefined;
  }

  private readSavedDashboardLayout(): SidebarLayout | undefined {
    return this.state
      ? loadSettings().sidebarSessionLayouts?.[
          canonicalUiSessionKeyForPersistence(this.state, this.state.sessionKey)
        ]
      : undefined;
  }

  captureNavigationFace(): "chat" | "dashboard" | undefined {
    const state = this.state;
    if (!state) {
      return this.routeFace;
    }
    if (!isSidebarSlotVisible(state.sidebarLayout, "dashboard")) {
      return this.readSavedDashboardLayout() !== undefined ? "chat" : this.routeFace;
    }
    this.retainDashboardPresentation(this.routeFace !== "dashboard");
    return "dashboard";
  }

  private retainDashboardPresentation(pendingRoute = false): void {
    this.dashboardPresentationActivation = {
      client: this.state?.client ?? null,
      key: boardProviderCacheKey(this.resolveBoardConversation()),
      expanded: this.dashboardExpanded,
      pendingRoute,
    };
  }

  protected syncRetainedBoardSession(board: ResolvedBoardView): void {
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const routeRequestsDashboard = this.routeFace === "dashboard" || this.dashboardExpanded;
    const activationKey = boardProviderCacheKey(this.resolveBoardConversation());
    const activation = this.dashboardPresentationActivation;
    const client = this.state?.client ?? null;
    const row = this.state ? selectedChatSessionRow(this.state) : undefined;
    const pendingRoute =
      activation?.pendingRoute === true &&
      activation.key === activationKey &&
      activation.client === client;
    if (activation && routeRequestsDashboard) {
      activation.pendingRoute = false;
    }
    if (!this.presented || (!routeRequestsDashboard && !pendingRoute)) {
      this.dashboardPresentationActivation = undefined;
    } else if (
      board.available &&
      sessionKey &&
      (activation?.key !== activationKey ||
        activation.client !== client ||
        activation.expanded !== this.dashboardExpanded)
    ) {
      const savedLayout = this.readSavedDashboardLayout();
      const hasPersonalLayout =
        savedLayout !== undefined && savedLayout.dashboardPresentationOverride !== null;
      if (this.dashboardExpanded || row || hasPersonalLayout) {
        const presentation =
          savedLayout?.dashboardPresentationOverride ?? row?.boardPresentation ?? "split";
        const savedPresentation =
          savedLayout &&
          (sidebarDashboardPresentation(savedLayout) ??
            (savedLayout.columns.some((column) =>
              column.panels.some((panel) => panel.slot === "dashboard"),
            )
              ? "split"
              : undefined));
        if (this.dashboardExpanded) {
          this.showDashboard(true);
        } else if (
          savedLayout &&
          (savedLayout.dashboardPresentationOverride === undefined ||
            savedPresentation === presentation)
        ) {
          // Preserve side tabs and legacy layouts when their presentation still applies.
          this.retainDashboardPresentation();
          this.commitSidebarLayout(this.restorePaneSidebarLayout(savedLayout), { persist: false });
        } else {
          this.showDashboard(presentation === "expanded");
        }
      }
    }
    if (sessionKey && board.provider.hasLoadedSnapshot) {
      const previous = this.observedBoardPresence.get(sessionKey);
      this.observedBoardPresence.set(sessionKey, board.hasBoard);
      if (
        this.presented &&
        previous === false &&
        board.hasBoard &&
        board.face === "chat" &&
        !this.readSavedDashboardLayout()
      ) {
        this.showDashboard((row?.boardPresentation ?? "split") === "expanded");
      }
    }
  }

  protected resolveBoardSessionKey(snapshotSessionKey = ""): string {
    const resolved = resolveSessionKey(
      snapshotSessionKey || this.state?.sessionKey || this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
  }

  protected refreshSwarmRoster(): void {
    const context = this.context;
    // Load before admission so mounting cannot retire the state captured by a held import.
    void import("../../lib/sessions/swarm-roster.ts")
      .then((swarm) => {
        if (!this.isConnected || this.context !== context) {
          return undefined;
        }
        return context.connectionBootstrap.run(
          this,
          async () => {
            if (this.context === context) {
              this.hydrateSwarmRoster(swarm);
            }
          },
          { background: true },
        );
      })
      .catch(() => undefined);
  }

  private hydrateSwarmRoster(swarm: typeof import("../../lib/sessions/swarm-roster.ts")): void {
    const state = this.state;
    const context = this.context;
    if (!state || !this.presented || !this.isConnected) {
      return;
    }
    const target = this.resolveChatReadTarget();
    if (!target) {
      this.swarm.hydrator?.dispose();
      this.swarm.hydrator = null;
      return;
    }
    const { sessionKey: parentKey, agentId } = target;
    const client = state.client;
    if (!client) {
      return;
    }
    const sourceEpoch = state.connectionEpoch;
    const isCurrent = () =>
      this.context === context &&
      this.state === state &&
      this.presented &&
      this.isConnected &&
      state.client === client &&
      state.connectionEpoch === sourceEpoch &&
      parentKey === this.resolveChatReadTarget()?.sessionKey &&
      agentId === this.resolveChatReadTarget()?.agentId;
    this.swarm.enabled = swarm.isSwarmEnabledInConfig(
      context.runtimeConfig ? currentDisplayConfig(context.runtimeConfig.state) : null,
      agentId,
    );
    // The child roster also owns ordinary subagent waits, launch rows, and
    // attention. Disabling swarm must not hide those recorded outcomes.
    if (!state.connected) {
      this.swarm.hydrator?.dispose();
      this.swarm.hydrator = null;
      return;
    }
    this.swarm.hydrator ??= new swarm.SwarmRosterHydrator();
    this.swarm.hydrator.update({
      sessions: context.sessions,
      parentKey,
      agentId,
      sourceEpoch,
      readParent: (refresh) =>
        context.sessions
          .describe(
            {
              key: parentKey,
              ...(parseAgentSessionKey(parentKey) ? {} : { agentId }),
            },
            { client, refresh },
          )
          .then((result) => result.session ?? null),
      currentRows: () => (isCurrent() ? (state.sessionsResult?.sessions ?? []) : []),
    });
  }

  protected resolveBoardView(): ResolvedBoardView {
    const provider = this.resolveBoardProvider();
    const snapshot = provider.snapshot$.value;
    const hasBoard = snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
    const sessionKey = this.resolveBoardSessionKey(snapshot.sessionKey);
    const saved = this.context.theme.settings.boardSessionViews?.[sessionKey];
    const savedTab = snapshot.tabs.some((tab) => tab.tabId === saved?.activeTabId)
      ? saved?.activeTabId
      : undefined;
    const activeTabId = savedTab ?? snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
    return {
      provider,
      snapshot,
      available:
        Boolean(this.boardProvider) ||
        (hasOperatorSelfReadAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
          isGatewayMethodAdvertised(this.context.gateway.snapshot, "board.get") !== false),
      hasBoard,
      face: this.routeFace ?? "chat",
      activeTabId,
    };
  }

  selectBoardTab(activeTabId: string): void {
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey) {
      return;
    }
    const boardSessionViews = this.context.theme.settings.boardSessionViews;
    const next = patchSettings({
      boardSessionViews: updateBoardSessionView(boardSessionViews, sessionKey, { activeTabId }),
    });
    if (this.state) {
      this.state.settings = next;
    }
  }

  protected isBoardPanelAvailable(board = this.resolveBoardView()): boolean {
    return board.available && Boolean(this.resolveBoardSessionKey(board.snapshot.sessionKey));
  }

  private pageBoardWidget(layout: SidebarLayout | undefined, board: ResolvedBoardView) {
    // Eligibility belongs to the loaded snapshot, not the lazy renderer registration.
    if (
      !layout ||
      !this.state ||
      !selectedChatSessionRow(this.state) ||
      !this.visuallyPresented ||
      !board.provider.hasLoadedSnapshot ||
      !isSidebarSlotVisible(layout, "dashboard")
    ) {
      return undefined;
    }
    const widgets = board.snapshot.widgets.filter((widget) => widget.tabId === board.activeTabId);
    const widget = widgets.length === 1 ? widgets[0] : undefined;
    return widget?.sizeW === BOARD_GRID_COLUMNS ? widget : undefined;
  }

  protected pageBoardWidgetMenu(
    layout: SidebarLayout | undefined,
  ): BoardWidgetPageMenu | undefined {
    const board = this.resolveBoardView();
    const widget = this.pageBoardWidget(layout, board);
    if (!widget) {
      return undefined;
    }
    const session = this.resolveBoardConversation();
    session.agentId ??= parseAgentSessionKey(board.snapshot.sessionKey)?.agentId;
    return {
      widget,
      tabs: board.snapshot.tabs,
      canMutate: board.provider.canMutate,
      onSelect: (value) => {
        const current = this.resolveBoardView();
        if (
          current.provider !== board.provider ||
          this.pageBoardWidget(this.state?.sidebarLayout, current) !== widget
        ) {
          return;
        }
        // The retained board owns actions and errors; the header only relocates its menu.
        const view = this.boardView;
        if (
          view?.isConnected &&
          view.snapshot?.sessionKey === board.snapshot.sessionKey &&
          view.session.agentId === session.agentId &&
          view.session.sessionKey === session.sessionKey
        ) {
          view.selectPageWidgetMenuItem(widget.name, widget.revision, value);
        }
      },
    };
  }

  protected boardPanelSource(
    board: ResolvedBoardView,
    layout: SidebarLayout,
  ): ChatBoardPanelSource | null {
    if (!this.isBoardPanelAvailable(board)) {
      return null;
    }
    return {
      owner: this,
      board,
      layout,
      session: this.resolveBoardConversation(),
      connectionGeneration: this.connectionGeneration,
      pageWidgetName: this.pageBoardWidget(layout, board)?.name,
    };
  }

  protected showDashboard(expanded: boolean): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const layout = openDashboardPresentation(state.sidebarLayout, expanded ? "expanded" : "split");
    // Retain the transient layout until the parent acknowledges its route.
    this.retainDashboardPresentation(this.routeFace !== "dashboard" && !this.dashboardExpanded);
    this.commitSidebarLayout(layout, { persist: false });
    this.onFaceChange?.(this.paneId, this.sessionKey, "dashboard");
  }

  protected handleBoardCommand(event: BoardCommandEvent): void {
    if (!this.presented) {
      return;
    }
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey || this.resolveBoardSessionKey(event.sessionKey) !== sessionKey) {
      return;
    }
    const command = event.command;
    if (command.kind === "focus_tab") {
      if (board.snapshot.tabs.some((tab) => tab.tabId === command.tabId)) {
        this.selectBoardTab(command.tabId);
        this.showDashboard(false);
      }
      return;
    }
    if (!board.activeTabId) {
      return;
    }
    this.showDashboard(command.dock === "hidden");
  }
}
