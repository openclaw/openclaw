import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-render.ts";
import { renderPanelLoadingSkeleton } from "../../components/panel-loading-skeleton.ts";
import { t } from "../../i18n/index.ts";
import { BOARD_GRID_COLUMNS } from "../../lib/board/grid.ts";
import {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
import { updateBoardSessionView } from "../../lib/board/settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { resolveSessionPreferredFace } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  canonicalUiSessionKeyForPersistence,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { ensureBoardViewElement, renderBoardSessionSurface } from "./board-session-surface.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
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
  private dashboardDefaultWrite?: { owner: string };

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
    const saving = this.dashboardDefaultWrite?.owner === this.dashboardDefaultWriteOwner;
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
      this.dashboardDefaultWrite?.owner === this.dashboardDefaultWriteOwner
    ) {
      return;
    }
    const operation = { owner: this.dashboardDefaultWriteOwner };
    this.dashboardDefaultWrite = operation;
    const isCurrent = () =>
      this.ownsHeaderOutcomeScope(scope) &&
      this.dashboardDefaultWrite === operation &&
      this.context.sessions === scope.sessions &&
      this.dashboardDefaultWriteOwner === operation.owner &&
      selectedChatSessionRow(scope.state)?.sessionId === row.sessionId;
    this.requestUpdate();
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
      showToast({ message: t("chat.sidePanel.defaultSaved"), anchor: this });
    } catch (error) {
      if (isCurrent()) {
        this.publishHeaderError(error, scope.headerOutcomeOwner);
        showToast({
          message: t("chat.sidePanel.defaultSaveError", { error: formatUiError(error) }),
          anchor: this,
        });
      }
    } finally {
      if (this.dashboardDefaultWrite === operation) {
        this.dashboardDefaultWrite = undefined;
        this.requestUpdate();
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
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(initialized, this.paneWidth) ?? initialized)
        : initialized;
    state.updateSidebarLayout(fitted, options);
  }

  protected initializeBrowserSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!layout.columns[0]?.browserWidthPending || !isSidebarSlotVisible(layout, "browser")) {
      return layout;
    }
    const composer = this.querySelector<HTMLElement>(".agent-chat__composer-shell");
    if (!composer) {
      return layout;
    }
    const inset = Number.parseFloat(
      getComputedStyle(composer).getPropertyValue("--chat-composer-side-inset"),
    );
    return initializeBrowserSidebarWidth(
      layout,
      this.querySelector(".sidebar-region")?.getBoundingClientRect().width ?? this.paneWidth,
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
    const fittedProjection =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(resizedProjection, this.paneWidth) ?? resizedProjection)
        : resizedProjection;
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
    const available = !gateway || isGatewayMethodAdvertised(gateway, "board.get") !== false;
    const canMutate = !gateway || hasOperatorWriteAccess(gateway.hello?.auth ?? null);
    const canGrant = !gateway || hasOperatorApprovalsAccess(gateway.hello?.auth ?? null);
    const canPinWidgets =
      canMutate &&
      (!gateway ||
        isGatewayCapabilityAdvertised(gateway, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true);
    const canPinMcpApps =
      canMutate &&
      (!gateway ||
        (isGatewayMethodAdvertised(gateway, "board.widget.appView") === true &&
          isGatewayMethodAdvertised(gateway, "board.widget.put") === true));
    const client = gateway?.client;
    if (this.boardProviderLifecycleConnected && client && available) {
      const key = boardProviderCacheKey(session);
      if (this.boardProviderLease?.cacheKey !== key) {
        this.releaseBoardProviderLease();
        this.boardProviderLease = {
          ...acquireBoardProviderForSession(
            session,
            client,
            gateway.phase === "connected",
            canPinWidgets,
            canPinMcpApps,
            canMutate,
            canGrant,
          ),
          cacheKey: key,
        };
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
    return boardProviderForSession(session, available);
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
    if (
      board.available &&
      this.state &&
      isSidebarSlotVisible(this.state.sidebarLayout, "dashboard") &&
      !customElements.get("openclaw-board-view")
    ) {
      void ensureBoardViewElement().then((loaded) => {
        if (loaded) {
          this.requestUpdate();
        }
      });
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
    let retry = false;
    void context.connectionBootstrap
      .run(
        this,
        async () => {
          if (this.context === context) {
            retry = await this.hydrateSwarmRoster();
          }
        },
        { background: true },
      )
      .then(() => {
        if (retry && this.context === context && this.presented && this.isConnected) {
          this.refreshSwarmRoster();
        }
      });
  }

  private async hydrateSwarmRoster(): Promise<boolean> {
    const state = this.state;
    const context = this.context;
    if (!state || !this.presented || !this.isConnected) {
      return false;
    }
    const target = this.resolveChatReadTarget();
    if (!target) {
      this.swarmHydrator?.dispose();
      this.swarmHydrator = null;
      return false;
    }
    const { sessionKey: parentKey, agentId } = target;
    const client = state.client;
    if (!client) {
      return false;
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
    let retry = false;
    await import("../../lib/sessions/swarm-roster.ts").then(
      ({ isSwarmEnabledInConfig, SwarmRosterHydrator }) => {
        if (!isCurrent()) {
          // The latest target must pass admission again after this import's task settles.
          retry = true;
          return;
        }
        const enabled =
          state.connected &&
          isSwarmEnabledInConfig(context.runtimeConfig?.state.configSnapshot?.config, agentId);
        if (!enabled) {
          if (this.swarmHydrator) {
            this.swarmHydrator.dispose();
            this.swarmHydrator = null;
            requestChatPageUpdate(state, "animation-frame");
          }
          return;
        }
        this.swarmHydrator ??= new SwarmRosterHydrator();
        this.swarmHydrator.update({
          sessions: context.sessions,
          parentKey,
          agentId,
          sourceEpoch,
          readParent: () =>
            client
              .request<{ session: GatewaySessionRow | null }>("sessions.describe", {
                key: parentKey,
                ...(parseAgentSessionKey(parentKey) ? {} : { agentId }),
              })
              .then((result) => result.session),
          currentRows: () => (isCurrent() ? (state.sessionsResult?.sessions ?? []) : []),
          onRows: () => {
            if (isCurrent()) {
              requestChatPageUpdate(state, "animation-frame");
            }
          },
        });
      },
    );
    return retry;
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
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "board.get") !== false,
      hasBoard,
      face: this.routeFace ?? "chat",
      activeTabId,
    };
  }

  private selectBoardTab(activeTabId: string): void {
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
    this.requestUpdate();
  }

  protected isBoardPanelAvailable(board = this.resolveBoardView()): boolean {
    return board.available && Boolean(this.resolveBoardSessionKey(board.snapshot.sessionKey));
  }

  private fullscreenBoardWidget(layout: SidebarLayout | undefined, board: ResolvedBoardView) {
    if (
      !layout ||
      !this.state ||
      !selectedChatSessionRow(this.state) ||
      !this.visuallyPresented ||
      !board.provider.hasLoadedSnapshot ||
      !customElements.get("openclaw-board-view") ||
      sidebarDashboardPresentation(layout) !== "expanded"
    ) {
      return undefined;
    }
    const widgets = board.snapshot.widgets.filter((widget) => widget.tabId === board.activeTabId);
    const widget = widgets.length === 1 ? widgets[0] : undefined;
    return widget?.sizeW === BOARD_GRID_COLUMNS ? widget : undefined;
  }

  protected fullscreenBoardWidgetMenu(
    layout: SidebarLayout | undefined,
    board = this.resolveBoardView(),
  ): BoardWidgetPageMenu | undefined {
    const widget = this.fullscreenBoardWidget(layout, board);
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
          this.fullscreenBoardWidget(this.state?.sidebarLayout, current) !== widget
        ) {
          return;
        }
        // The retained board owns actions and errors; the header only relocates its menu.
        const view = this.querySelector("openclaw-board-view");
        if (
          view?.snapshot?.sessionKey === board.snapshot.sessionKey &&
          view.session.agentId === session.agentId &&
          view.session.sessionKey === session.sessionKey
        ) {
          view.selectPageWidgetMenuItem(widget.name, widget.revision, value);
        }
      },
    };
  }

  protected renderBoardPanel(board: ResolvedBoardView, layout: SidebarLayout) {
    const session = this.resolveBoardConversation();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!this.isBoardPanelAvailable(board)) {
      return nothing;
    }
    if (!board.provider.hasLoadedSnapshot) {
      const error = board.provider.loadError$.value;
      return error
        ? html`<div
            class="board-session-surface__state board-session-surface__state--error"
            role="alert"
          >
            ${t("dashboardDocument.loadFailed", { error })}
          </div>`
        : renderPanelLoadingSkeleton("board", t("common.loading"));
    }
    // Only the loaded board acknowledgment supplies a missing owner; its display key
    // must not replace the original session target (notably global versus a literal key).
    session.agentId ??= parseAgentSessionKey(board.snapshot.sessionKey)?.agentId;
    const boardActive = isSidebarSlotVisible(layout, "dashboard") && this.visuallyPresented;
    const renderSurface = (active: boolean) =>
      renderBoardSessionSurface({
        active,
        session,
        snapshot: board.snapshot,
        activeTabId: board.activeTabId,
        pageWidgetName: this.fullscreenBoardWidget(layout, board)?.name,
        canMutate: board.provider.canMutate,
        canGrant: board.provider.canGrant,
        callbacks: {
          appViewGeneration: board.provider.appViewGeneration,
          applyOps: (ops) => board.provider.applyOps(ops),
          grant: (name, decision) => board.provider.grant(name, decision),
          selectTab: (tabId) => {
            this.onFaceChange?.(this.paneId, this.sessionKey, "dashboard");
            this.selectBoardTab(tabId);
          },
          frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
          widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
          refreshWidgetAppView: (name, revision) =>
            board.provider.refreshWidgetAppView(name, revision),
        } satisfies BoardViewCallbacks,
        widgetFrameUrl: (name, revision) => board.provider.widgetFrameUrl(name, revision),
      });
    // Keep one template boundary so hiding the panel does not remount app iframes.
    return html`${
      boardActive
        ? renderSurface(true)
        : guard([sessionKey, session.agentId], () => renderSurface(false))
    }`;
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
