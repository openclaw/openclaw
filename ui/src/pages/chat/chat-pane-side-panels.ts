import type { SessionsCompanionStateResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { SESSION_COMPANION_SELECTION_CONTEXT_MAX_CHARS } from "../../../../packages/gateway-protocol/src/session-companion-contract.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { shellViewport, type ShellViewportSnapshot } from "../../app/shell-viewport.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { buildCompanionQuestionPrefill } from "../../lib/chat/companion-question.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import type { ChatMobileHost, MobileHostDestination } from "./chat-mobile-host.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";
import { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import {
  ChatSessionCompanionThreads,
  type ChatSessionCompanionTurn,
  requestSessionCompanionAnswer,
} from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { formatChatSelectionAnnotation } from "./components/chat-selection-attachment.ts";
import type { SidebarLayout, SidebarSlotId } from "./sidebar-layout-types.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  isSidebarNewTabActive,
  openSlot,
  presentNarrowSidebarLayout,
  promoteSidebarPanel,
  setSidebarOpen,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

export abstract class ChatPaneSidePanels extends ChatPaneStateOwner {
  sidebarRegionElement: HTMLElement | null = null;
  sidebarRegionView: HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | null = null;
  readonly mobilePresentation: {
    session: string;
    open: boolean | undefined;
    suspended: boolean;
    mode: "dock" | "expanded";
    height: number | undefined;
    sheetHeight: number | undefined;
    reservedHeight: number;
    destination: MobileHostDestination;
    persistentDestination: MobileHostDestination;
    detailsMount: HTMLElement | null;
    source: HTMLElement | undefined;
    composerEditing: boolean;
    publishedKeyboard: boolean | undefined;
    viewportRecovery: { width: number; height: number; reduced: boolean } | undefined;
  } = {
    session: "",
    open: undefined,
    suspended: false,
    mode: "dock",
    height: undefined,
    sheetHeight: undefined,
    reservedHeight: 0,
    destination: { area: "panels" },
    persistentDestination: { area: "panels" },
    detailsMount: null,
    source: undefined,
    composerEditing: false,
    publishedKeyboard: undefined,
    viewportRecovery: undefined,
  };

  protected get sessionPresentation(): "desktop" | "mobile" | undefined {
    if (parseCatalogSessionKey(this.state?.sessionKey ?? "")) {
      return undefined;
    }
    return this.mergedChrome ? "mobile" : "desktop";
  }

  protected get usesMobileHost(): boolean {
    return (
      this.mergedChrome &&
      !this.compact &&
      !this.onBackToSubagents &&
      !parseCatalogSessionKey(this.state?.sessionKey ?? "")
    );
  }

  /** Presentation memory belongs to this pane, never to a leaf or the saved desktop layout. */
  protected mobileHost(layout: SidebarLayout): ChatMobileHost | undefined {
    if (!this.usesMobileHost) {
      return undefined;
    }
    const session = `${gatewayPresentationScope(this.context.gateway).key}\0${resolveChatAgentId(this.state!)}\0${this.state?.sessionKey}`;
    if (session !== this.mobilePresentation.session) {
      this.mobilePresentation.session = session;
      this.mobilePresentation.open = undefined;
      this.mobilePresentation.suspended = false;
      this.mobilePresentation.mode = "dock";
      this.mobilePresentation.height = undefined;
      this.mobilePresentation.sheetHeight = undefined;
      this.mobilePresentation.reservedHeight = 0;
      this.mobilePresentation.destination = { area: "panels" };
      this.mobilePresentation.persistentDestination = this.mobilePresentation.destination;
      this.mobilePresentation.source = undefined;
      this.mobilePresentation.composerEditing = false;
      this.mobilePresentation.viewportRecovery = undefined;
    }
    return {
      scopeKey: this.mobilePresentation.session,
      open:
        this.mobilePresentation.open ??
        (layout.open === true ||
          (sidebarMainPanel(layout)?.slot ?? "conversation") !== "conversation"),
      suspended: this.mobilePresentation.suspended,
      mode: this.mobilePresentation.mode,
      height:
        this.mobilePresentation.destination.page?.presentation === "sheet"
          ? this.mobilePresentation.sheetHeight
          : this.mobilePresentation.height,
      reservedHeight: this.mobilePresentation.reservedHeight,
      destination: this.mobilePresentation.destination,
      detailsMount: this.mobilePresentation.detailsMount,
      setDetailsMount: (element) => {
        if (element !== this.mobilePresentation.detailsMount) {
          this.mobilePresentation.detailsMount = element;
        }
      },
      navigate: (destination, source) => this.navigateMobileHost(destination, source),
      reveal: (source) => this.navigateMobileHost(this.mobilePresentation.destination, source),
      close: () => {
        this.mobilePresentation.open = false;
        this.mobilePresentation.sheetHeight = undefined;
        if (this.mobilePresentation.destination.transient) {
          this.mobilePresentation.destination = this.mobilePresentation.persistentDestination;
        }
        this.mobilePresentation.reservedHeight = 0;
        this.mobilePresentation.source?.focus({ preventScroll: true });
        this.syncMobileObserverVisibility();
      },
      back: () => {
        if (this.mobilePresentation.destination.backTo) {
          this.navigateMobileHost(this.mobilePresentation.destination.backTo);
        }
      },
      toggleExpanded: (visibleDockHeight) => {
        if (this.mobilePresentation.destination.page?.expandable === false) {
          return;
        }
        if (this.mobilePresentation.mode === "dock") {
          this.mobilePresentation.reservedHeight = visibleDockHeight;
          this.mobilePresentation.mode = "expanded";
        } else {
          this.mobilePresentation.mode = "dock";
          this.mobilePresentation.reservedHeight = 0;
        }
        this.mobilePresentation.height = undefined;
      },
      resize: (height, mode, reservedHeight) => {
        if (this.mobilePresentation.destination.page?.presentation === "sheet") {
          this.mobilePresentation.sheetHeight = height;
          return;
        }
        this.mobilePresentation.height = height;
        if (mode) {
          this.mobilePresentation.mode = mode;
        }
        if (reservedHeight !== undefined) {
          this.mobilePresentation.reservedHeight = reservedHeight;
        }
      },
      keyboardVisible: shellViewport.snapshot?.keyboardVisible,
      onComposerEditingChange: this.onMobileComposerEditingChange,
      onViewportChange: this.onMobileViewportChange,
    };
  }

  private readonly onMobileComposerEditingChange = (editing: boolean): void => {
    if (!this.usesMobileHost || editing === this.mobilePresentation.composerEditing) {
      return;
    }
    this.mobilePresentation.composerEditing = editing;
    const previousSuspended = this.mobilePresentation.suspended;
    const viewport = shellViewport.snapshot;
    if (editing) {
      this.mobilePresentation.suspended = true;
      this.mobilePresentation.viewportRecovery = viewport
        ? {
            width: viewport.width,
            height: viewport.keyboardVisible
              ? Math.max(viewport.layoutHeight, viewport.focusHeight ?? 0)
              : viewport.height,
            reduced: viewport.keyboardVisible,
          }
        : undefined;
    } else if (!this.mobilePresentation.viewportRecovery) {
      this.mobilePresentation.suspended = false;
    }
    if (previousSuspended !== this.mobilePresentation.suspended) {
      this.syncMobileObserverVisibility();
    }
    this.onMobileViewportChange(viewport);
  };

  private readonly onMobileViewportChange = (viewport: ShellViewportSnapshot | undefined): void => {
    const recovery = this.mobilePresentation.viewportRecovery;
    const previousSuspended = this.mobilePresentation.suspended;
    if (viewport && recovery && this.mobilePresentation.suspended && viewport.nativeScale) {
      // Blur clears the detector's keyboard flag before the viewport necessarily
      // recovers. Compare the observed geometry with this edit's starting height.
      if (viewport.width !== recovery.width) {
        this.mobilePresentation.viewportRecovery = viewport.keyboardVisible
          ? {
              width: viewport.width,
              height: Math.max(viewport.layoutHeight, viewport.focusHeight ?? 0),
              reduced: true,
            }
          : undefined;
        this.mobilePresentation.suspended = viewport.keyboardVisible;
      } else if (viewport.height < recovery.height - 1) {
        recovery.reduced = true;
      } else if (recovery.reduced || !this.mobilePresentation.composerEditing) {
        this.mobilePresentation.viewportRecovery = undefined;
        this.mobilePresentation.suspended = false;
      }
    }
    const suspensionChanged = previousSuspended !== this.mobilePresentation.suspended;
    if (suspensionChanged) {
      this.syncMobileObserverVisibility();
    }
    if (
      suspensionChanged ||
      this.mobilePresentation.publishedKeyboard !== viewport?.keyboardVisible
    ) {
      this.mobilePresentation.publishedKeyboard = viewport?.keyboardVisible;
    }
  };

  protected navigateMobileHost(destination: MobileHostDestination, source?: HTMLElement): void {
    if (!this.usesMobileHost) {
      return;
    }
    if (destination.page?.key !== this.mobilePresentation.destination.page?.key) {
      this.mobilePresentation.sheetHeight = undefined;
    }
    this.mobilePresentation.destination = destination;
    if (!destination.transient) {
      this.mobilePresentation.persistentDestination = destination;
    }
    this.mobilePresentation.open = true;
    this.mobilePresentation.suspended = false;
    // Explicit reveal wins until a new editing transition, not a repeated fact.
    this.mobilePresentation.viewportRecovery = undefined;
    if (source) {
      this.mobilePresentation.source = source;
    }
    if (
      destination.area === "details" &&
      !destination.page &&
      this.mobilePresentation.detailsMount
    ) {
      this.mobilePresentation.detailsMount.scrollTop = 0;
    }
    this.syncMobileObserverVisibility();
  }

  private syncMobileObserverVisibility(): void {
    const layout = this.state?.sidebarLayout;
    if (layout?.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(this.isSlotShown(layout, "companion"));
    }
  }

  protected sessionCompanionHydrationKey = "";
  protected sessionCompanionFocusGeneration = 0;
  private sessionCompanionPresented = false;
  readonly companionIntents: {
    focusRequest?: () => boolean;
    /** The subagent requested by the panel, or null for its list; taken once. */
    subagentsShowRequest?: () => string | null | undefined;
    /** The narrow pane control to restore focus to; taken once by the region. */
    sideFocusOrigin?: () => HTMLElement | null;
  } = { focusRequest: undefined, subagentsShowRequest: undefined, sideFocusOrigin: undefined };
  readonly sessionCompanionThreads = new ChatSessionCompanionThreads();
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
  };

  protected restorePaneSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!this.compact) {
      return layout;
    }
    // Home's visibility consumers share the restored Chat-first layout;
    // the saved full-page task layout stays intact.
    const conversation = layout.columns[0]?.panels.find((panel) => panel.slot === "conversation");
    const restored = conversation ? promoteSidebarPanel(layout, conversation.id) : layout;
    return { ...restored, open: false, expanded: false };
  }

  protected setChatSidePanelOpen(open: boolean, layout?: SidebarLayout): void {
    if (this.usesMobileHost) {
      if (open || this.mobilePresentation.suspended) {
        this.navigateMobileHost(
          this.mobilePresentation.destination.area === "panels"
            ? this.mobilePresentation.destination
            : { area: "panels" },
        );
      } else {
        this.mobileHost(layout ?? this.state!.sidebarLayout)?.close();
      }
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    const renderedLayout = layout ?? state.sidebarLayout;
    const nextLayout = setSidebarOpen(renderedLayout, open);
    if (renderedLayout.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(isSidebarSlotVisible(nextLayout, "companion"));
    }
    this.commitSidebarLayout(
      nextLayout,
      sidebarMainPanel(renderedLayout)?.slot === "dashboard"
        ? { dashboardPresentation: "personal" }
        : undefined,
    );
  }

  protected toggleConversationPanel(layout: SidebarLayout): void {
    const changeSlot = isSidebarSlotVisible(layout, "conversation") ? closeSlot : openSlot;
    const nextLayout = changeSlot(layout, "conversation");
    this.commitSidebarLayout(nextLayout, { dashboardPresentation: "personal" });
    if (layout.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(isSidebarSlotVisible(nextLayout, "companion"));
    }
  }

  protected requestSessionRail(intent: "open" | "toggle"): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const closing =
      intent === "toggle" &&
      (this.usesMobileHost
        ? this.isSlotShown(state.sidebarLayout, "companion")
        : isSidebarSlotVisible(state.sidebarLayout, "companion"));
    const changeSlot = closing ? closeSlot : openSlot;
    this.commitSidebarLayout(changeSlot(state.sidebarLayout, "companion"));
    if (!closing) {
      this.navigateMobileHost({ area: "panels", slot: "companion" });
    }
    this.setSessionObserverVisibility(!closing);
  }

  /** Opens the Subagents panel on one subagent, or on its list. */
  protected showSubagents(subagentKey: string | null, focus = false): void {
    const sessionKey = this.state?.sessionKey;
    // The pane owns the intent across the panel's lazy mount; the panel takes
    // it once, and only for the session that asked.
    const take = () => {
      if (this.companionIntents.subagentsShowRequest === take) {
        this.companionIntents.subagentsShowRequest = undefined;
      }
      return this.state?.sessionKey === sessionKey ? subagentKey : undefined;
    };
    this.companionIntents.subagentsShowRequest = take;
    this.requestBackgroundPanel("subagents", "open");
    if (focus) {
      void this.focusSubagentsPanel();
    }
  }

  private async focusSubagentsPanel(): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const sessionKey = state.sessionKey;
    await customElements.whenDefined("openclaw-chat-sidebar-region");
    await new Promise<void>((resolve) => {
      state.renderLifecycle.afterCommit(() => resolve(), resolve);
    });
    const region = this.sidebarRegionView;
    await region?.updateComplete;
    if (
      this.isConnected &&
      this.state === state &&
      state.sessionKey === sessionKey &&
      this.isSlotShown(state.sidebarLayout, "subagents")
    ) {
      region?.focusActiveSideTab({ preventScroll: true });
    }
  }

  /** The layout as this pane shows it, which a narrow pane decides for the background panels. */
  protected presentSidebarLayout(layout: SidebarLayout): SidebarLayout {
    const mobile = this.mobileHost(layout);
    if (mobile) {
      const next = ensureSidebarConversation(layout);
      const conversation = next.columns[0]!.panels.find((panel) => panel.slot === "conversation")!;
      const shown =
        next.mainPanelId === conversation.id ? next : promoteSidebarPanel(next, conversation.id);
      const panels = layout.columns[0]?.panels;
      const selected =
        panels?.find(
          (panel) => panel.slot === mobile.destination.slot && panel.slot !== "conversation",
        ) ??
        panels?.find(
          (panel) => panel.id === layout.columns[0]?.activePanelId && panel.slot !== "conversation",
        );
      if (!mobile.destination.slot && isSidebarNewTabActive(layout)) {
        shown.columns[0]!.activePanelId = layout.newTab!.id;
      } else if (selected) {
        shown.columns[0]!.activePanelId = selected.id;
      }
      return {
        ...shown,
        open: mobile.open && !mobile.suspended && mobile.destination.area === "panels",
        expanded: false,
        expandedSide: false,
      };
    }
    return this.mergedChrome ? presentNarrowSidebarLayout(layout, { allPanels: true }) : layout;
  }

  protected isSlotShown(layout: SidebarLayout, slot: SidebarSlotId): boolean {
    return isSidebarSlotVisible(this.presentSidebarLayout(layout), slot);
  }

  protected requestBackgroundPanel(
    slot: "subagents" | "processes",
    intent: "open" | "close" | "toggle",
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const closing =
      intent === "close" ||
      (intent === "toggle" &&
        (this.usesMobileHost
          ? this.isSlotShown(state.sidebarLayout, slot)
          : isSidebarSlotVisible(state.sidebarLayout, slot)));
    let origin: HTMLElement | null = null;
    if (!closing && this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX) {
      // Desktop moves focus with the narrow region; the mobile dock retains
      // this same opener for its native Close action.
      const active = this.element.ownerDocument.activeElement;
      origin = active instanceof HTMLElement && this.element.contains(active) ? active : null;
      const take = () => {
        if (this.companionIntents.sideFocusOrigin === take) {
          this.companionIntents.sideFocusOrigin = undefined;
        }
        return origin;
      };
      this.companionIntents.sideFocusOrigin = take;
    }
    this.commitSidebarLayout(
      closing ? closeSlot(state.sidebarLayout, slot) : openSlot(state.sidebarLayout, slot),
    );
    if (!closing) {
      this.navigateMobileHost({ area: "panels", slot }, origin ?? undefined);
    }
  }

  protected syncSessionCompanionPresentation(presented: boolean): void {
    if (
      this.sessionCompanionPresented === presented &&
      (presented || this.companionIntents.focusRequest === undefined)
    ) {
      return;
    }
    this.sessionCompanionPresented = presented;
    if (presented && this.state) {
      this.companionIntents.focusRequest ??= this.captureSessionCompanionFocus(
        this.state,
      ).requestFocus;
    } else {
      this.sessionCompanionFocusGeneration += 1;
      this.companionIntents.focusRequest = undefined;
    }
  }

  private captureSessionCompanionFocus(pageState: ChatPageHost) {
    const sessionKey = pageState.sessionKey;
    const agentId = resolveChatAgentId(pageState);
    const generation = this.connectionGeneration;
    const focusGeneration = this.sessionCompanionFocusGeneration;
    const composer = getChatComposerState(this.presentationId);
    const editRevision = composer.editRevision;
    const draft = pageState.chatMessage;
    const ownsFocus = () =>
      this.state === pageState &&
      pageState.sessionKey === sessionKey &&
      resolveChatAgentId(pageState) === agentId &&
      this.connectionGeneration === generation &&
      this.sessionCompanionFocusGeneration === focusGeneration &&
      composer.editRevision === editRevision &&
      pageState.chatMessage === draft &&
      this.sessionCompanionPresented &&
      (this.element.ownerDocument.activeElement === this.element.ownerDocument.body ||
        this.element.contains(this.element.ownerDocument.activeElement)) &&
      this.isConnected &&
      this.active &&
      this.visuallyPresented &&
      this.presented;
    const requestFocus = () => {
      if (this.companionIntents.focusRequest === requestFocus) {
        this.companionIntents.focusRequest = undefined;
      }
      return ownsFocus();
    };
    return { ownsFocus, requestFocus };
  }

  protected async openSessionCompanion(pageState: ChatPageHost, question: string): Promise<void> {
    const { ownsFocus, requestFocus } = this.captureSessionCompanionFocus(pageState);
    // The first lazy mount and the completed answer share the same input intent.
    this.companionIntents.focusRequest = requestFocus;
    await this.submitSessionCompanionQuestion(question);
    if (ownsFocus()) {
      this.companionIntents.focusRequest = requestFocus;
    }
  }

  protected readonly submitSessionCompanionQuestion = async (
    question: string | ChatSessionCompanionTurn,
  ) => {
    const state = this.state;
    if (!state || !state.sessionKey) {
      return;
    }
    const { sessionKey, client, connected } = state;
    const agentId = resolveChatAgentId(state);
    this.requestSessionRail("open");
    const text = typeof question === "string" ? question : question.question;
    if (!text.trim()) {
      return;
    }
    if (!connected || !client) {
      this.sessionCompanionThreads.setDraft(sessionKey, text, agentId);
      return;
    }
    const attachments =
      typeof question === "string"
        ? this.sessionCompanionThreads.view(sessionKey, agentId).attachments
        : question.attachments;
    if (
      attachments?.some((attachment) => !attachment.selectionAnnotation) &&
      !uploadsEnabled(state.uploadConfig)
    ) {
      showToast({ message: uploadsDisabledMessage() });
      return;
    }
    // The question carries the model controls shown when it was asked.
    const modelSelection = this.sessionCompanionThreads.view(sessionKey, agentId).modelSelection;
    const ask = (key: string, value: string, requestedAttachments?: ChatAttachment[]) =>
      requestSessionCompanionAnswer(
        client,
        key,
        value,
        agentId,
        requestedAttachments,
        state.uploadConfig,
        modelSelection,
      );
    await this.sessionCompanionThreads.submit(sessionKey, question, ask, agentId);
  };

  protected readonly stageSessionCompanionAttachment = (
    attachment: ChatAttachment,
    sourceSessionKey: string,
  ): boolean => {
    const state = this.state;
    if (!state || state.sessionKey !== sourceSessionKey || !attachment.selectionAnnotation) {
      return false;
    }
    const agentId = resolveChatAgentId(state);
    const thread = this.sessionCompanionThreads.view(sourceSessionKey, agentId);
    const nextAttachments = [...(thread.attachments ?? []), attachment];
    // Only an oversized passage gets the old quote-only path; comments stay correctable.
    if (
      formatChatSelectionAnnotation({ ...attachment.selectionAnnotation, comment: "" }).length >
      SESSION_COMPANION_SELECTION_CONTEXT_MAX_CHARS
    ) {
      showToast({
        message: t(
          thread.draft.trim() ? "chat.rail.selectionTooLong" : "chat.rail.selectionQuoteOnly",
        ),
      });
    } else if (
      !this.sessionCompanionThreads.setAttachments(sourceSessionKey, nextAttachments, agentId)
    ) {
      return false;
    }
    if (!thread.draft.trim()) {
      this.sessionCompanionThreads.setDraft(
        sourceSessionKey,
        buildCompanionQuestionPrefill(attachment.selectionAnnotation.text) ?? "",
        agentId,
      );
    }
    this.requestSessionRail("open");
    return true;
  };

  protected hydrateSessionCompanion(sessionKey: string): void {
    const state = this.state;
    if (!state?.connected || !state.client || !sessionKey || parseCatalogSessionKey(sessionKey)) {
      return;
    }
    const agentId = resolveChatAgentId(state);
    const hydrationKey = `${this.connectionGeneration}\0${agentId}\0${sessionKey}`;
    if (this.sessionCompanionHydrationKey === hydrationKey) {
      return;
    }
    this.sessionCompanionHydrationKey = hydrationKey;
    void this.sessionCompanionThreads.hydrate(
      sessionKey,
      (key) =>
        state.client!.request<SessionsCompanionStateResult>("sessions.companion.state", {
          sessionKey: key,
          ...(agentId ? { agentId } : {}),
        }),
      agentId,
    );
  }
}
