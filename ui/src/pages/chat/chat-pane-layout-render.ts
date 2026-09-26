import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import "./chat-outbox-recovery.ts";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { availableLinkReaders } from "../../app/link-reader-routing.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { latestBrowserTabCards } from "../../lib/chat/browser-tab-preview.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import {
  availableSidebarSlots,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "./chat-pane-embedded-panels.ts";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, sidebarRegionCallbacks } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { ChatToolIconController } from "./chat-tool-icon-controller.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { publishChatWorkContext } from "./chat-work-context.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import {
  renderSessionWorkspaceRail,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import { renderChatTasksPanel } from "./components/chat-tasks-panel.ts";
import { resolveAssistantDisplayAvatar } from "./components/chat-welcome.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  sidebarMainPanel,
  isSidebarSlotVisible,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneLayoutRenderParams = {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  currentAgentId: string;
  board: ResolvedBoardView;
  sidebarLayout: SidebarLayout;
  sessionWorkspace: SessionWorkspaceProps;
  backgroundTasks: BackgroundTasksProps;
  chatProps: ChatProps;
  observerDigest: SessionObserverDigest | null;
  observerRunId: string | null;
  catalog: boolean;
  agentWorkspace: string | undefined;
  workspaceGit: boolean;
  openPanelSlot: (slot: SidebarSlotId) => void;
  closePanelSlot: (slot: SidebarSlotId) => void;
};

export abstract class ChatPaneLayoutRender extends ChatPaneBrowserAnnotationRender {
  private readonly toolIcons = new ChatToolIconController(
    this,
    () => this.context,
    () => (this.state && !this.catalogHost ? this.resolveChatReadTarget() : undefined),
  );
  private desktopFocus: {
    key: string;
    client: ChatPageHost["client"];
    href: string;
  } | null = null;

  protected renderChatPaneLayout(params: ChatPaneLayoutRenderParams) {
    const {
      state,
      selectedSession,
      currentAgentId,
      board,
      sidebarLayout,
      sessionWorkspace,
      backgroundTasks,
      chatProps,
      observerDigest,
      observerRunId,
      catalog,
      agentWorkspace,
      workspaceGit,
      openPanelSlot,
      closePanelSlot,
    } = params;
    if (this.inputRegion === "page") {
      const preview = state.sessionWorkspaceState?.previews.find(
        (entry) => entry.id === state.sessionWorkspaceState?.activePreviewId,
      )?.content;
      const file =
        preview?.kind === "file" && isSidebarSlotVisible(sidebarLayout, "workspace")
          ? preview
          : undefined;
      const workspace = resolveSessionWorkspace({
        session: selectedSession,
        agentWorkspace,
        worktreePath: selectedSession?.worktree
          ? this.headerWorktreePaths.get(selectedSession.worktree.id)?.path
          : undefined,
      });
      publishChatWorkContext(
        this.context,
        this,
        this.presented && this.selected
          ? {
              sessionKey: state.sessionKey,
              sessionId: state.currentSessionId ?? undefined,
              agentId: currentAgentId,
              workspace: file?.root ?? workspace.root ?? undefined,
              file: file?.path,
            }
          : undefined,
      );
    }
    const recovery = html`<openclaw-chat-outbox-recovery
      .host=${state}
      .identity=${JSON.stringify([
        state.settings.gatewayUrl,
        state.connected && state.client?.recoveryScopeReady ? state.client.recoveryScope : null,
        storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)),
      ])}
      @outbox-restored=${() => {
        this.chatState.restoreComposer();
        state.requestUpdate?.();
      }}
    ></openclaw-chat-outbox-recovery>`;
    const latestBrowserTabs = latestBrowserTabCards(chatProps.messages, chatProps.toolMessages);
    const chat = renderChat({
      ...chatProps,
      pluginToolIcons: this.toolIcons.icons,
      presented: this.active && this.presented,
      transcriptVisible:
        this.presented &&
        this.visuallyPresented &&
        isSidebarSlotVisible(sidebarLayout, "conversation"),
      latestBrowserTabs: this.active && this.presented ? latestBrowserTabs : undefined,
      historyState: catalog ? undefined : state,
      header: nothing,
    });
    const primary = html`<div class="chat-pane-primary-column">${chat}</div>`;
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const discussionState = this.sessionDiscussionStates.get(state.sessionKey.trim());
    const discussionAvailable = discussionState === "available" || discussionState === "open";
    const desktopAvailable = isDesktopPanelAvailable(this.context.gateway.snapshot);
    const companionSessionKey = state.sessionKey;
    const companionThread = this.sessionCompanionThreads.view(companionSessionKey, currentAgentId);
    const companionPresented =
      this.presented && this.visuallyPresented && isSidebarSlotVisible(sidebarLayout, "companion");
    // Capture the opening before the lazy rail can yield to newer input intent.
    this.syncSessionCompanionPresentation(companionPresented);
    const browserPresented =
      this.active && this.presented && isSidebarSlotVisible(sidebarLayout, "browser");
    const browserTabsInHeader = sidebarMainPanel(sidebarLayout)?.slot !== "browser";
    const terminalTabsInHeader = sidebarMainPanel(sidebarLayout)?.slot !== "terminal";
    // Another pane can own keyboard focus while this desktop remains visible.
    const desktopPresented =
      this.presented && this.visuallyPresented && isSidebarSlotVisible(sidebarLayout, "desktop");
    const desktopRefreshOnPresentation = !this.pendingPanelToggleRequests.has("desktop");
    const discoveredDesktopSource = this.activeSessionResources.desktopSource(
      state.client,
      state.sessionKey,
      scopedAgentParamsForSession(state, state.sessionKey).agentId,
      state.connectionEpoch,
      this.resourceSessionObservation()?.row ?? undefined,
    );
    const desktopSource =
      sidebarLayout.columns
        .flatMap((column) => column.panels)
        .find((panel) => panel.slot === "desktop")?.environmentId ??
      (discoveredDesktopSource !== undefined
        ? discoveredDesktopSource
        : resolveChatPaneDesktopTarget(selectedSession));
    const desktopFocusKey = JSON.stringify([
      state.sessionKey,
      this.connectionGeneration,
      desktopAvailable,
      desktopPresented,
      state.basePath,
    ]);
    if (this.desktopFocus?.key !== desktopFocusKey || this.desktopFocus.client !== state.client) {
      this.desktopFocus = {
        key: desktopFocusKey,
        client: state.client,
        href: buildControlUiFocusPath(
          { kind: "desktop", session: state.sessionKey },
          state.basePath,
        ),
      };
    }
    const desktopFocus = this.desktopFocus;
    const panelDefinitions = sidebarPanelDefinitions({
      state,
      themeMode: this.context.theme.resolvedMode,
      agentId: currentAgentId,
      browserPresented,
      browserTabsInHeader,
      linkReaders: availableLinkReaders(this.context.gateway.snapshot),
      linkReaderPresented:
        this.presented &&
        this.visuallyPresented &&
        isSidebarSlotVisible(sidebarLayout, "link-reader"),
      linkReaderTabsInHeader: sidebarMainPanel(sidebarLayout)?.slot !== "link-reader",
      onCloseLinkReader: () => closePanelSlot("link-reader"),
      terminalTabsInHeader,
      browserRefreshOnPresentation: !this.pendingPanelToggleRequests.has("browser"),
      preferredBrowserTab: [...latestBrowserTabs.values()].at(-1),
      desktopPresented,
      desktopRefreshOnPresentation,
      desktopAvailable,
      desktopSource,
      portalPresented:
        this.presented && this.visuallyPresented && isSidebarSlotVisible(sidebarLayout, "portal"),
      desktopFocusHref: desktopFocus.href,
      onDesktopFocusTargetChange: (target) => {
        // A retained callback cannot publish a previous presentation's source or control state.
        const href = buildControlUiFocusPath(target, state.basePath);
        if (this.desktopFocus === desktopFocus && desktopFocus.href !== href) {
          desktopFocus.href = href;
          this.requestUpdate();
        }
      },
      dashboard: !this.compact ? this.renderBoardPanel(board, sidebarLayout) : nothing,
      workspace: renderSessionWorkspaceRail(sessionWorkspace, { embedded: true }),
      tasks: renderChatTasksPanel({
        backgroundTasks,
        host: state,
        presented: this.presented,
        loadFullAssistantMessage: chatProps.loadFullAssistantMessage,
      }),
      renderDetail: (content) =>
        renderChatDetailSlot({
          chat: chatProps,
          content,
          host: state,
        }),
      digest: observerDigest,
      activeRunId: observerRunId,
      startedAt: selectedSession?.startedAt ?? state.chatStreamStartedAt ?? undefined,
      lastReadAt: selectedSession?.lastReadAt,
      pullRequests: this.sessionPullRequests,
      companion: companionThread,
      companionFocusRequest: this.sessionCompanionFocusRequest,
      companionPresented,
      onCompanionSubmit: (question) => void this.submitSessionCompanionQuestion(question),
      onCompanionDraftChange: (draft) =>
        this.sessionCompanionThreads.setDraft(state.sessionKey, draft, currentAgentId),
      onCompanionAttachmentsChange: (attachments) =>
        this.sessionCompanionThreads.setAttachments(
          companionSessionKey,
          attachments,
          currentAgentId,
        ),
      onCompanionVisibilityChange: this.setSessionObserverVisibility,
      connected: state.connected,
      onClearCompanion: () => void this.clearSessionCompanion(),
      onRefreshTasks: backgroundTasks.onRefresh,
      tasksLoading: backgroundTasks.loading,
      discussion,
      discussionAvailable,
      discussionOpenUrl: discussion?.openUrl ?? null,
      discussionSourceGeneration: this.connectionGeneration,
      pluginPanels: this.context.plugins.registrations("panels"),
      isPluginPanelPresented: (slot) =>
        this.active && this.presented && isSidebarSlotVisible(sidebarLayout, slot),
    });
    const availableSlots = availableSidebarSlots(panelDefinitions);
    const panelTemplates = sidebarPanelTemplates(panelDefinitions);
    const panelActions = sidebarPanelTemplates(panelDefinitions, "headerAction");
    // Main panel actions share the task toolbar. Content roots stay in the
    // sidebar region so changing their presentation never reconnects them.
    const header = this.compact
      ? nothing
      : html`${this.renderPaneHeader(
            sessionWorkspace,
            backgroundTasks,
            selectedSession,
            catalog,
            agentWorkspace,
            workspaceGit,
            chatProps.placementStartup,
            sidebarLayout,
            panelDefinitions,
          )}<openclaw-plugin-contributions
            .kind=${"session-header"}
            .sessionKey=${state.sessionKey}
            .agentId=${currentAgentId}
            .presented=${this.visuallyPresented}
          ></openclaw-plugin-contributions>`;
    const content = renderSidebarRegion({
      presentationId: this.presentationId,
      conversationTab: {
        label: chatProps.assistantName,
        icon: renderAgentIdentityAvatar(resolveAssistantDisplayAvatar(chatProps)),
      },
      availableWidth: this.paneWidth,
      fetchFavicon: resolveChatLinkFaviconFetcher(state),
      availableSlots,
      callbacks: sidebarRegionCallbacks({
        state,
        layout: sidebarLayout,
        closePanelSlot,
        openPanelSlot,
        forgetDiscussionUrl: () => this.sessionDiscussionOpenUrls.delete(state.sessionKey.trim()),
        resizePanel: (columnId, size) =>
          this.commitSidebarPanelResize(sidebarLayout, columnId, size),
        setPanelOpen: (open) => this.setChatSidePanelOpen(open, sidebarLayout),
      }),
      layout: sidebarLayout,
      panelDefinitions,
      panelActions,
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
      panelTemplates,
      header: html`${header}${recovery}`,
      primary,
      requestUpdate: state.requestUpdate!,
    });
    return html`${content}
    ${renderChatImageLightbox(
      state.imageLightbox,
      state.handleCloseImage,
    )}${this.renderResetConfirmation()}`;
  }
}
