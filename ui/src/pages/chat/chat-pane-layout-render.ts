import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import "./components/chat-details.tsx";
import type { GatewaySessionRow } from "../../api/types.ts";
import { availableLinkReaders } from "../../app/link-reader-routing.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { latestBrowserTabCards } from "../../lib/chat/browser-tab-preview.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import { PaneOutboxRecovery } from "./chat-outbox-recovery.tsx";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { PaneDetailsProps } from "./chat-pane-header-view.tsx";
import type { PaneLayoutData } from "./chat-pane-layout-view.tsx";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, sidebarRegionCallbacks } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createChatToolIcons, type PluginToolIcons } from "./chat-tool-icon-controller.ts";
import type { ChatProps } from "./chat-view.tsx";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { hasTerminalRunStatus } from "./components/chat-composer-state.ts";
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
  sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
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
  private toolIcons?: PluginToolIcons;

  mountToolIcons(revision: () => unknown): void {
    this.toolIcons = createChatToolIcons(() => {
      revision();
      return {
        context: this.context,
        session: this.state && !this.catalogHost ? this.resolveChatReadTarget() : undefined,
      };
    });
  }
  private desktopFocus: {
    key: string;
    client: ChatPageHost["client"];
    href: string;
  } | null = null;

  protected renderChatPaneLayout(params: ChatPaneLayoutRenderParams): PaneLayoutData | null {
    const {
      state,
      selectedSession,
      currentAgentId,
      board,
      sidebarLayout: savedLayout,
      sessionWorkspace,
      chatProps,
      observerDigest,
      observerRunId,
      catalog,
      agentWorkspace,
      workspaceGit,
      openPanelSlot,
      closePanelSlot,
    } = params;
    // What the pane shows. Its controls keep working on the layout as it is saved.
    const sidebarLayout = this.presentSidebarLayout(savedLayout);
    const conversationVisible = isSidebarSlotVisible(sidebarLayout, "conversation");
    const workspace = resolveSessionWorkspace({
      session: selectedSession,
      agentWorkspace,
      worktreePath: selectedSession?.worktree
        ? this.headerWorktreePaths.get(selectedSession.worktree.id)?.path
        : undefined,
    });
    if (this.inputRegion === "page") {
      const preview = state.sessionWorkspaceState?.previews.find(
        (entry) => entry.id === state.sessionWorkspaceState?.activePreviewId,
      )?.content;
      const file =
        preview?.kind === "file" && isSidebarSlotVisible(sidebarLayout, "workspace")
          ? preview
          : undefined;
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
    // Recovery mutates the composer, so do not mount it in a view-only conversation.
    const recovery =
      chatProps.disabledBanner?.kind === "composer-replacement"
        ? null
        : {
            component: PaneOutboxRecovery,
            state,
            identity: JSON.stringify([
              state.settings.gatewayUrl,
              state.connected && state.client?.recoveryScopeReady
                ? state.client.recoveryScope
                : null,
              storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)),
              state.currentSessionId,
            ]),
            onRestored: () => {
              this.chatState.composerPersistence.restore();
              state.requestUpdate?.();
            },
          };
    const latestBrowserTabs = latestBrowserTabCards(chatProps.messages, chatProps.toolMessages);
    const panePresentation = { owner: this.element, isPresented: () => this.presented };
    const slotPresentation = (slot: SidebarSlotId, mode: "visible" | "active" = "visible") => ({
      owner: this.element,
      isPresented: () =>
        this.presented &&
        (mode === "active" ? this.active : this.visuallyPresented) &&
        isSidebarSlotVisible(sidebarLayout, slot),
    });
    // Only a full pane has a Subagents panel of its own. Elsewhere a subagent's
    // name still opens its session and their count stays text.
    const ownsSubagentsPanel = !catalog && !this.compact;
    const paneChatProps: ChatProps = {
      ...chatProps,
      error: conversationVisible ? chatProps.error : null,
      detailsEnabled: !catalog && !this.compact,
      detailsWorkspace: {
        ...workspace,
        branch:
          selectedSession?.repository?.branch ??
          selectedSession?.worktree?.branch ??
          chatProps.pullRequestsBranch?.branch,
      },
      onOpenWorkspace: () => openPanelSlot("workspace"),
      onOpenSubagent: ownsSubagentsPanel ? (key) => this.showSubagents(key) : undefined,
      onOpenSubagents: ownsSubagentsPanel ? (focus) => this.showSubagents(null, focus) : undefined,
      onOpenProcesses: ownsSubagentsPanel
        ? () => this.requestBackgroundPanel("processes", "open")
        : undefined,
      composerRecovery: recovery,
      pluginToolIcons: this.toolIcons,
      presented: {
        owner: this.element,
        isPresented: () => (this.active || Boolean(this.onBackToSubagents)) && this.presented,
      },
      progressCardVisibility: panePresentation,
      transcriptVisible: slotPresentation("conversation"),
      latestBrowserTabs: this.active && this.presented ? latestBrowserTabs : undefined,
      historyState: catalog ? undefined : state,
    };
    const headerDetails: PaneDetailsProps | undefined = ownsSubagentsPanel
      ? {
          chat: paneChatProps,
          mobile: this.mergedChrome && !this.onBackToSubagents,
          presentation: panePresentation,
          conversationVisible,
          externalTrigger:
            (sidebarMainPanel(sidebarLayout)?.slot ?? "conversation") !== "conversation",
          setRef: (details) => {
            this.headerDetailsRef.value = details;
          },
        }
      : undefined;
    const subagentStop =
      chatProps.disabledBanner?.presentation &&
      chatProps.canAbort &&
      chatProps.onAbort &&
      !hasTerminalRunStatus(chatProps.runStatus)
        ? { onAbort: chatProps.onAbort }
        : undefined;
    const subagentHeader = this.onBackToSubagents
      ? {
          onBack: this.onBackToSubagents,
          title: this.resolveHeaderSessionTitle(selectedSession),
          stop: subagentStop,
          details: headerDetails,
        }
      : null;
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const discussionState = this.sessionDiscussionStates.get(state.sessionKey.trim());
    const discussionAvailable = discussionState === "available" || discussionState === "open";
    const desktopAvailable = isDesktopPanelAvailable(this.context.gateway.snapshot);
    const companionSessionKey = state.sessionKey;
    // Publish the mutable owner's current fields across the reactive property boundary.
    const companionThread = {
      ...this.sessionCompanionThreads.view(companionSessionKey, currentAgentId),
    };
    const companionPresented = slotPresentation("companion");
    // Capture the opening before the lazy rail can yield to newer input intent.
    this.syncSessionCompanionPresentation(companionPresented.isPresented());
    // Another pane can own keyboard focus while this desktop remains visible.
    const desktopPresented = slotPresentation("desktop");
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
      desktopPresented.isPresented(),
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
      paneId: this.paneId,
      panePresentationId: this.presentationId,
      subagentsInputRegion: this.inputRegion,
      subagentsPresented: slotPresentation("subagents"),
      processesPresented: slotPresentation("processes"),
      subagentsAvailable: !catalog,
      subagentsShowRequest: this.subagentsShowRequest,
      onSubagentSessionSelect: (sessionKey, options) =>
        this.onPaneSessionChange?.(this.paneId, sessionKey, options),
      panePresentation,
      state,
      themeMode: this.context.theme.resolvedMode,
      agentId: currentAgentId,
      browserPresented: slotPresentation("browser", "active"),
      browserTabsInHeader: sidebarMainPanel(sidebarLayout)?.slot !== "browser",
      linkReaders: availableLinkReaders(this.context.gateway.snapshot),
      linkReaderPresented: slotPresentation("link-reader"),
      linkReaderTabsInHeader: sidebarMainPanel(sidebarLayout)?.slot !== "link-reader",
      onCloseLinkReader: () => closePanelSlot("link-reader"),
      terminalTabsInHeader: sidebarMainPanel(sidebarLayout)?.slot !== "terminal",
      onCloseTerminal: () => closePanelSlot("terminal"),
      browserRefreshOnPresentation: !this.pendingPanelToggleRequests.has("browser"),
      preferredBrowserTab: [...latestBrowserTabs.values()].at(-1),
      sessionBrowserTabs: [...latestBrowserTabs.values()].map((selection) => selection.tab),
      desktopPresented,
      desktopRefreshOnPresentation: !this.pendingPanelToggleRequests.has("desktop"),
      desktopAvailable,
      desktopSource,
      portalPresented: slotPresentation("portal"),
      desktopFocusHref: desktopFocus.href,
      onDesktopFocusTargetChange: (target) => {
        // A retained callback cannot publish a previous presentation's source or control state.
        const href = buildControlUiFocusPath(target, state.basePath);
        if (this.desktopFocus === desktopFocus && desktopFocus.href !== href) {
          desktopFocus.href = href;
          this.invalidate();
        }
      },
      dashboard: !this.compact ? this.renderBoardPanel(board, sidebarLayout) : null,
      workspace: sessionWorkspace,
      detail: { chat: chatProps, host: state, requestUpdate: state.requestUpdate! },
      digest: observerDigest,
      activeRunId: observerRunId,
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
      connected: state.connected,
      onClearCompanion: () => void this.clearSessionCompanion(),
      discussion,
      discussionAvailable,
      discussionOpenUrl: discussion?.openUrl ?? null,
      discussionSourceGeneration: this.connectionGeneration,
      pluginPanels: this.context.plugins.registrations("panels"),
      isPluginPanelPresented: (slot) => slotPresentation(slot, "active"),
    });
    const callbacks = sidebarRegionCallbacks({
      state,
      layout: savedLayout,
      closePanelSlot,
      openPanelSlot,
      forgetDiscussionUrl: () => this.sessionDiscussionOpenUrls.delete(state.sessionKey.trim()),
      resizePanel: (columnId, size) => this.commitSidebarPanelResize(savedLayout, columnId, size),
      setPanelOpen: (open) => this.setChatSidePanelOpen(open, savedLayout),
    });
    const connectionGeneration = this.connectionGeneration;
    // Main panel actions share the task toolbar. Content roots stay in the
    // sidebar region so changing their presentation never reconnects them.
    const header =
      subagentHeader || this.compact
        ? null
        : {
            header: this.renderPaneHeader(
              sessionWorkspace,
              selectedSession,
              catalog,
              agentWorkspace,
              workspaceGit,
              chatProps.placementStartup,
              savedLayout,
              panelDefinitions,
              subagentStop,
              headerDetails,
              { openPanelSlot: callbacks.openSlot, closePanelSlot: callbacks.closeSlot },
            ),
            notice:
              !conversationVisible && chatProps.error
                ? { error: chatProps.error, onDismissError: chatProps.onDismissError }
                : undefined,
            sessionKey: state.sessionKey,
            agentId: currentAgentId,
            presentation: {
              owner: this.element,
              isPresented: () => this.visuallyPresented,
              preview: () => !this.presented && this.connectionGeneration === connectionGeneration,
            },
          };
    const avatar = resolveAssistantDisplayAvatar(chatProps);
    const region = renderSidebarRegion({
      presentationId: this.presentationId,
      conversationTab: { label: chatProps.assistantName, avatar },
      availableWidth: this.paneWidth,
      fetchFavicon: resolveChatLinkFaviconFetcher(state),
      callbacks,
      layout: sidebarLayout,
      sideFocusLocked: sidebarLayout !== savedLayout,
      sideFocusManaged:
        companionPresented.isPresented() && Boolean(this.sessionCompanionFocusRequest),
      sideFocusOrigin: this.sideFocusOrigin,
      panelDefinitions,
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
      requestUpdate: state.requestUpdate!,
    });
    return {
      region,
      header,
      subagentHeader,
      primary: { chat: paneChatProps, application: this.context },
      background: {
        context: this.context,
        surface: "session",
        presented:
          this.presented &&
          this.visuallyPresented &&
          isSidebarSlotVisible(sidebarLayout, "conversation"),
      },
      overlays: {
        presentation: panePresentation,
        image: state.imageLightbox,
        onCloseImage: state.handleCloseImage,
        reset: this.renderResetConfirmation(),
      },
    };
  }
}
