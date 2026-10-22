import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { merge } from "solid-js";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { availableLinkReaders } from "../../app/link-reader-routing.ts";
import "./components/chat-details.tsx";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { latestBrowserTabCards } from "../../lib/chat/browser-tab-preview.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import { PaneOutboxRecovery } from "./chat-outbox-recovery.tsx";
import { PaneAttachmentCatalog } from "./chat-pane-attachment-catalog.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { ChatPaneHeaderLayout, type PaneDetailsActions } from "./chat-pane-header-layout.ts";
import type { PaneLayoutData } from "./chat-pane-layout-view.tsx";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import { hasTerminalRunStatus } from "./chat-run-working.ts";
import { createSideChatModelControlProps } from "./chat-session-companion-model-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createChatToolIcons, type PluginToolIcons } from "./chat-tool-icon-controller.ts";
import type { ChatProps } from "./chat-view.tsx";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatDetailsElements } from "./components/chat-details.tsx";
import type { SidebarRegionCallbacks } from "./components/chat-sidebar-region-types.ts";
import { resolveAssistantDisplayAvatar } from "./components/chat-welcome.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  openSidebarNewTab,
  closeSidebarNewTab,
  replaceSidebarNewTab,
  finishSidebarCloseAll,
  promoteSidebarPanel,
  setSidebarDock,
  activatePanel,
  sidebarActivePanel,
  sidebarMainPanel,
  setSidebarExpanded,
  isSidebarSlotVisible,
  reorderPanel,
  toggleSidebarPanelExpanded,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneLayoutRenderParams = {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  currentAgentId: string;
  board: ResolvedBoardView;
  sidebarLayout: SidebarLayout;
  sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"] &
    Pick<ChatProps, "onScrollPortRef">;
  chatProps: ChatProps;
  detailsActions: PaneDetailsActions;
  observerDigest: SessionObserverDigest | null;
  observerRunId: string | null;
  catalog: boolean;
  agentWorkspace: string | undefined;
  workspaceGit: boolean;
  openPanelSlot: (slot: SidebarSlotId) => void;
  closePanelSlot: (slot: SidebarSlotId) => void;
};

export abstract class ChatPaneLayoutRender extends ChatPaneHeaderLayout {
  private readonly detailsElements: ChatDetailsElements = {
    getComposerInput: () => getChatComposerState(this.presentationId).composerInput,
  };

  private registerDetailsElement(
    name: "pane" | "header" | "frame" | "footer",
    element: HTMLElement,
  ) {
    this.detailsElements[name] = element;
    return () => {
      if (this.detailsElements[name] === element) {
        delete this.detailsElements[name];
      }
    };
  }

  protected readonly onSidebarPanelOpened = (slot: SidebarSlotId) => {
    const destination = this.mobilePresentation.destination;
    const backTo = destination.area === "details" ? destination : undefined;
    this.navigateMobileHost({ area: "panels", slot, backTo });
  };

  get composerReady(): boolean {
    return getChatComposerState(this.presentationId).composerTextarea?.isConnected === true;
  }

  focusComposerInput(): boolean {
    const composer = getChatComposerState(this.presentationId).composerTextarea;
    if (!this.active || !composer?.isConnected || composer.disabled) {
      return false;
    }
    composer.focus({ preventScroll: true });
    return true;
  }

  private toolIcons?: PluginToolIcons;
  private readonly attachmentCatalog = new PaneAttachmentCatalog();

  override dispose(): void {
    this.attachmentCatalog.dispose();
    super.dispose();
  }

  mountToolIcons(readGateway: () => unknown): void {
    this.toolIcons = createChatToolIcons(() => {
      readGateway();
      return {
        context: this.context,
        session: this.state && !this.history.catalogHost ? this.resolveChatReadTarget() : undefined,
      };
    });
  }
  desktopFocus: {
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
      detailsActions,
      observerDigest,
      observerRunId,
      catalog,
      agentWorkspace,
      workspaceGit,
      openPanelSlot,
      closePanelSlot,
    } = params;
    const mobileHost = this.mobileHost(savedLayout);

    // What the pane shows. Its controls keep working on the layout as it is saved.
    const sidebarLayout = this.presentSidebarLayout(savedLayout);
    const conversationVisible = isSidebarSlotVisible(sidebarLayout, "conversation");
    const workspace = resolveSessionWorkspace({
      session: selectedSession,
      agentWorkspace,
      worktreePath: selectedSession?.worktree
        ? this.headerPresentation.worktreePaths.get(selectedSession.worktree.id)?.path
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
              this.chatState.composerPersistence.persistChangedState();
            },
          };
    const latestBrowserTabs = latestBrowserTabCards(chatProps.messages, chatProps.toolMessages);
    const panePresentation = { owner: this.element, isPresented: () => this.presented };
    const connectionGeneration = this.connectionGeneration;
    const headerPresentation = {
      owner: this.element,
      isPresented: () => this.visuallyPresented,
      preview: () => !this.presented && this.connectionGeneration === connectionGeneration,
    };
    const slotPresentation = (slot: SidebarSlotId, mode: "visible" | "active" = "visible") => ({
      owner: this.element,
      isPresented: () =>
        this.presented &&
        (mode === "active" ? this.active : this.visuallyPresented) &&
        (slot === "conversation" || !mobileHost?.destination.page) &&
        isSidebarSlotVisible(sidebarLayout, slot),
    });
    // Only a full pane has a Subagents panel of its own. Elsewhere a subagent's
    // name still opens its session and their count stays text.
    const ownsSubagentsPanel = !catalog && !this.compact;
    const subagentStop =
      chatProps.disabledBanner?.presentation &&
      chatProps.canAbort &&
      chatProps.onAbort &&
      !hasTerminalRunStatus(chatProps.runStatus)
        ? {
            target: JSON.stringify([
              this.connectionGeneration,
              state.sessionKey,
              state.currentSessionId,
              observerRunId ?? state.chatRunId,
              selectedSession?.activeRunIds,
            ]),
            onAbort: chatProps.onAbort,
          }
        : undefined;
    const subagentStopInNotice =
      this.sessionPresentation === "desktop" &&
      !this.onBackToSubagents &&
      chatProps.disabledBanner?.presentation === "compact";
    const paneChatProps: ChatProps = merge(chatProps, {
      onConversationFrameRef: (element) => this.registerDetailsElement("frame", element),
      onFooterElementRef: (element) => this.registerDetailsElement("footer", element),
      disabledBanner:
        subagentStopInNotice && chatProps.disabledBanner
          ? { ...chatProps.disabledBanner, stop: subagentStop }
          : chatProps.disabledBanner,
      mobileComposer: Boolean(mobileHost),
      showNewMessages:
        (this.sessionPresentation !== "desktop" || conversationVisible) &&
        chatProps.showNewMessages,
      mobileActivities: mobileHost
        ? this.mobileChatActivities(state, selectedSession, chatProps)
        : undefined,
      mobileKeyboardVisible: mobileHost?.keyboardVisible,
      onComposerEditingChange: mobileHost?.onComposerEditingChange,
      error: conversationVisible ? chatProps.error : null,
      detailsEnabled: !catalog && !this.compact,
      detailsWorkspace: {
        ...workspace,
        branch:
          selectedSession?.repository?.branch ??
          selectedSession?.worktree?.branch ??
          chatProps.pullRequestsBranch?.branch,
      },
      onOpenSidebar: chatProps.onOpenSidebar
        ? (content) => {
            const slot = chatProps.onOpenSidebar?.(content);
            if (slot) {
              this.navigateMobileHost({ area: "panels", slot });
            }
          }
        : undefined,
      onOpenWorkspaceFile: chatProps.onOpenWorkspaceFile
        ? (target) => {
            const result = chatProps.onOpenWorkspaceFile?.(target);
            // The native file owner admits the preview synchronously before its async read.
            if (state.connected && state.client) {
              this.onSidebarPanelOpened("workspace");
            }
            return result;
          }
        : undefined,
      onOpenWorkspace: () => openPanelSlot("workspace"),
      onOpenSessionDiff: chatProps.onOpenSessionDiff
        ? () => {
            chatProps.onOpenSessionDiff?.();
            this.onSidebarPanelOpened("detail");
          }
        : undefined,
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
    } satisfies Partial<ChatProps>);
    sessionWorkspace.transcriptAttachments = this.attachmentCatalog.read({
      state,
      selectedSession,
      currentAgentId,
      chatProps,
      paneChatProps,
      gateway: this.context.gateway,
      presentation: this.sessionPresentation,
      workspacePresented: slotPresentation("workspace").isPresented(),
      sessionWorkspace,
    });
    const { headerDetails, subagentHeader } = this.renderHeaderDetails({
      elements: this.detailsElements,
      state,
      selectedSession,
      chatProps,
      paneChatProps,
      detailsActions,
      subagentStop,
      ownsSubagentsPanel,
      mobileHost,
      sidebarLayout,
      headerPresentation,
      panePresentation,
      conversationVisible,
    });
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const discussionState = this.sessionDiscussion.snapshot.states.get(state.sessionKey.trim());
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
    const toggleMobilePanel = (slot: SidebarSlotId) =>
      isSidebarSlotVisible(sidebarLayout, slot) ? closePanelSlot(slot) : openPanelSlot(slot);
    const headerWorkspace = mobileHost
      ? {
          ...sessionWorkspace,
          onScrollPortRef: this.mobileScrollFades.register,
          collapsed: !isSidebarSlotVisible(sidebarLayout, "workspace"),
          onOpenDiff: sessionWorkspace.onOpenDiff
            ? () => {
                sessionWorkspace.onOpenDiff?.();
                this.navigateMobileHost({ area: "panels", slot: "detail" });
              }
            : undefined,
          onToggleCollapsed: () => toggleMobilePanel("workspace"),
          onToggleTerminal: sessionWorkspace.onToggleTerminal
            ? () => toggleMobilePanel("terminal")
            : undefined,
          onToggleBrowser: sessionWorkspace.onToggleBrowser
            ? () => toggleMobilePanel("browser")
            : undefined,
          onToggleDesktop: sessionWorkspace.onToggleDesktop
            ? () => toggleMobilePanel("desktop")
            : undefined,
        }
      : { ...sessionWorkspace, onScrollPortRef: this.mobileScrollFades.register };
    const desktopPanel = savedLayout.columns[0]?.panels.find((panel) => panel.slot === "desktop");
    const desktopIsMain = desktopPanel !== undefined && desktopPanel.id === savedLayout.mainPanelId;
    const desktopExpanded =
      savedLayout.expanded === true &&
      (desktopIsMain
        ? !savedLayout.expandedSide
        : savedLayout.expandedSide === true &&
          desktopPanel !== undefined &&
          savedLayout.columns[0]?.activePanelId === desktopPanel.id);
    const panelDefinitions = sidebarPanelDefinitions({
      onScrollPortRef: this.mobileScrollFades.register,
      paneId: this.paneId,
      presentation: this.sessionPresentation,
      panePresentationId: this.presentationId,
      subagentsInputRegion: this.inputRegion,
      subagentsPresented: slotPresentation("subagents"),
      processesPresented: slotPresentation("processes"),
      subagentsAvailable: !catalog,
      subagentsShowRequest: this.companionIntents.subagentsShowRequest,
      onSubagentSessionSelect: (sessionKey, options) =>
        this.onPaneSessionChange?.(this.paneId, sessionKey, options),
      panePresentation,
      detailPresented: slotPresentation("detail"),
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
      browserRefreshOnPresentation: !this.pendingPanelToggles.requests.has("browser"),
      preferredBrowserTab: [...latestBrowserTabs.values()].at(-1),
      sessionBrowserTabs: [...latestBrowserTabs.values()].map((selection) => selection.tab),
      desktopPresented,
      desktopExpanded,
      onToggleDesktopExpanded: () => {
        if (!desktopPanel) {
          return;
        }
        if (desktopIsMain) {
          state.updateSidebarLayout(setSidebarExpanded(savedLayout, !desktopExpanded), {
            dashboardPresentation: "personal",
          });
        } else {
          nativeCallbacks.togglePanelExpanded(desktopPanel.id);
        }
      },
      desktopRefreshOnPresentation: !this.pendingPanelToggles.requests.has("desktop"),
      desktopAvailable,
      desktopSource,
      desktopRuntimeConfig: this.context.runtimeConfig,
      portalPresented: slotPresentation("portal"),
      desktopFocusHref: desktopFocus.href,
      onDesktopFocusTargetChange: (target) => {
        // A retained callback cannot publish a previous presentation's source or control state.
        const href = buildControlUiFocusPath(target, state.basePath);
        if (
          this.desktopFocus?.key === desktopFocus.key &&
          this.desktopFocus.client === desktopFocus.client &&
          this.desktopFocus.href !== href
        ) {
          this.desktopFocus = { ...this.desktopFocus, href };
        }
      },
      dashboard: !this.compact ? this.renderBoardPanel(board, sidebarLayout) : null,
      workspace: headerWorkspace,
      workspacePresented: slotPresentation("workspace"),
      detail: {
        chat: paneChatProps,
        presentation: this.sessionPresentation,
        host: state,
        onOpenMobilePage: mobileHost
          ? (request, source) =>
              this.navigateMobileHost(
                {
                  area: "panels",
                  slot: "detail",
                  page: { key: request.key, title: request.title, render: request.render },
                  backTo: { area: "panels", slot: "detail" },
                },
                source,
              )
          : undefined,
        onWorkspaceIntent: mobileHost
          ? () => this.navigateMobileHost({ area: "panels", slot: "workspace" })
          : undefined,
      },
      digest: observerDigest,
      activeRunId: observerRunId,
      pullRequests: this.sessionPullRequests,
      companion: companionThread,
      companionModelControls: createSideChatModelControlProps({
        state,
        companion: companionThread,
        onSelect: (patch) => this.sessionCompanionThreads.setModelSelection(currentAgentId, patch),
      }),
      companionFocusRequest: this.companionIntents.focusRequest,
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
      onClearCompanion: this.clearSessionCompanion,
      discussion,
      discussionAvailable,
      discussionOpenUrl: discussion?.openUrl ?? null,
      discussionSourceGeneration: this.connectionGeneration,
      pluginPanels: this.context.plugins.registrations("panels"),
      isPluginPanelPresented: (slot) => slotPresentation(slot, "active"),
    });
    const setPanelOpen = (open: boolean) => this.setChatSidePanelOpen(open, savedLayout);
    const nativeCallbacks: SidebarRegionCallbacks = {
      newTab: {
        open: (options) => state.updateSidebarLayout(openSidebarNewTab(savedLayout, options)),
        close: () => state.updateSidebarLayout(closeSidebarNewTab(state.sidebarLayout)),
        openPanel: (slot) => {
          openPanelSlot(slot);
          state.updateSidebarLayout(replaceSidebarNewTab(savedLayout, state.sidebarLayout, slot));
        },
        finishCloseAll: () => {
          const next = finishSidebarCloseAll(state.sidebarLayout);
          if (!next) {
            return false;
          }
          state.updateSidebarLayout(next);
          return true;
        },
      },
      activatePanel: (panelId) => {
        const slot = savedLayout.columns[0]?.panels.find((panel) => panel.id === panelId)?.slot;
        if (slot === "dashboard" && !isSidebarSlotVisible(savedLayout, "dashboard")) {
          openPanelSlot(slot);
        } else {
          state.updateSidebarLayout(activatePanel(savedLayout, panelId));
        }
        state.updateSidebarActivePanel(panelId);
      },
      promotePanel: (panelId) =>
        state.updateSidebarLayout(promoteSidebarPanel(savedLayout, panelId)),
      togglePanelExpanded: (panelId) => {
        state.updateSidebarLayout(toggleSidebarPanelExpanded(savedLayout, panelId), {
          dashboardPresentation: "personal",
        });
        if (panelId !== undefined) {
          state.updateSidebarActivePanel(panelId);
        }
      },
      setDock: (dock) =>
        state.updateSidebarLayout(setSidebarDock(savedLayout, dock), { geometryOnly: true }),
      closeSlot: (slot) => {
        if (slot === "conversation") {
          setPanelOpen(false);
          return;
        }
        if (slot === "discussion") {
          this.sessionDiscussion.forgetOpenUrl(state.sessionKey.trim());
        }
        closePanelSlot(slot);
      },
      openSlot: openPanelSlot,
      reorderPanel: (panelId, targetPanelId, placement) =>
        state.updateSidebarLayout(reorderPanel(savedLayout, panelId, targetPanelId, placement)),
      resizePanel: (columnId, size) => this.commitSidebarPanelResize(savedLayout, columnId, size),
      setOpen: setPanelOpen,
    };
    const updateMobileCatalogLayout = (next: SidebarLayout) => {
      // Catalog navigation changes selection, not the retained desktop expansion.
      const { expanded, expandedSide } = state.sidebarLayout;
      state.updateSidebarLayout({ ...next, expanded, expandedSide });
    };
    const callbacks = mobileHost
      ? {
          ...nativeCallbacks,
          newTab: nativeCallbacks.newTab
            ? {
                ...nativeCallbacks.newTab,
                open: (options?: { returnPanelId?: string }) => {
                  updateMobileCatalogLayout(openSidebarNewTab(state.sidebarLayout, options));
                  mobileHost.navigate({ area: "panels" });
                },
                close: () => {
                  updateMobileCatalogLayout(closeSidebarNewTab(state.sidebarLayout));
                  mobileHost.navigate({ area: "panels" });
                },
              }
            : undefined,
          activatePanel: (panelId: string) => {
            if (panelId === savedLayout.newTab?.id) {
              updateMobileCatalogLayout(activatePanel(state.sidebarLayout, panelId));
              state.updateSidebarActivePanel(panelId);
              mobileHost.navigate({ area: "panels" });
              return;
            }
            const panel = savedLayout.columns[0]?.panels.find((entry) => entry.id === panelId);
            if (panel) {
              mobileHost.navigate({ area: "panels", slot: panel.slot });
            }
          },
          togglePanelExpanded: (panelId?: string) => {
            const panel = panelId
              ? savedLayout.columns[0]?.panels.find((entry) => entry.id === panelId)
              : sidebarActivePanel(savedLayout);
            if (panel) {
              mobileHost.navigate({ area: "panels", slot: panel.slot });
            }
          },
        }
      : nativeCallbacks;
    // Main panel actions share the task toolbar. Content roots stay in the
    // sidebar region so changing their presentation never reconnects them.
    const paneHeader =
      subagentHeader || this.compact
        ? null
        : this.renderPaneHeader(
            headerWorkspace,
            selectedSession,
            catalog,
            agentWorkspace,
            workspaceGit,
            chatProps.placementStartup,
            mobileHost ? sidebarLayout : savedLayout,
            panelDefinitions,
            subagentStopInNotice ? undefined : subagentStop,
            headerDetails,
            { openPanelSlot: callbacks.openSlot, closePanelSlot: callbacks.closeSlot },
          );
    const header = paneHeader && {
      header: paneHeader,
      notice:
        !conversationVisible && chatProps.error
          ? { error: chatProps.error, onDismissError: chatProps.onDismissError }
          : undefined,
      sessionKey: state.sessionKey,
      agentId: currentAgentId,
      presentation: headerPresentation,
    };
    const externalPanelsToggle = this.sessionPresentation === "desktop" && header !== null;
    if (header) {
      this.configureHeaderPanelPresentation({
        nativeHeader: header.header.header,
        headerDetails,
        state,
        currentAgentId,
        sidebarLayout,
        panelDefinitions,
        catalog,
        externalPanelsToggle,
      });
    }
    const avatar = resolveAssistantDisplayAvatar(chatProps);
    const region = renderSidebarRegion({
      mobileScrollFades: this.mobileScrollFades,
      onRegionElementRef: (element) => {
        this.sidebarRegionElement = element;
        const release = this.registerDetailsElement("pane", element);
        return () => {
          release();
          if (this.sidebarRegionElement === element) {
            this.sidebarRegionElement = null;
          }
        };
      },
      onHeaderElementRef: (element) => this.registerDetailsElement("header", element),
      onRegionViewRef: (element) => {
        this.sidebarRegionView = element;
        return () => {
          if (this.sidebarRegionView === element) {
            this.sidebarRegionView = null;
          }
        };
      },
      presentationId: this.presentationId,
      presentation: this.compact || this.onBackToSubagents ? undefined : this.sessionPresentation,
      mobileHost,
      externalPanelsToggle,
      conversationTab: { label: chatProps.assistantName, avatar },
      availableWidth: this.paneWidth,
      fetchFavicon: resolveChatLinkFaviconFetcher(state),
      callbacks,
      layout: sidebarLayout,
      sideFocusLocked: !mobileHost && sidebarLayout !== savedLayout,
      sideFocusManaged:
        companionPresented.isPresented() && Boolean(this.companionIntents.focusRequest),
      sideFocusOrigin: this.companionIntents.sideFocusOrigin,
      panelDefinitions,
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
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
