import type { SessionsCompanionStateResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { SESSION_COMPANION_SELECTION_CONTEXT_MAX_CHARS } from "../../../../packages/gateway-protocol/src/session-companion-contract.js";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { buildCompanionQuestionPrefill } from "../../lib/chat/companion-question.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
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
  isSidebarSlotVisible,
  openSlot,
  presentNarrowSidebarLayout,
  promoteSidebarPanel,
  setSidebarOpen,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

export abstract class ChatPaneSidePanels extends ChatPaneBase {
  protected sessionCompanionHydrationKey = "";
  protected sessionCompanionFocusGeneration = 0;
  private sessionCompanionPresented = false;
  protected sessionCompanionFocusRequest?: () => boolean;
  /** The subagent the Subagents panel was asked to show, or null for its list; taken once. */
  protected subagentsShowRequest?: () => string | null | undefined;
  /** The control a background panel was opened from in a narrow pane; the region takes it once. */
  protected sideFocusOrigin?: () => HTMLElement | null;
  protected readonly sessionCompanionThreads = new ChatSessionCompanionThreads(() => {
    this.requestUpdate();
  });
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
    this.requestUpdate();
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

  protected requestSessionRail(intent: "open" | "toggle"): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const closing = intent === "toggle" && isSidebarSlotVisible(state.sidebarLayout, "companion");
    const changeSlot = closing ? closeSlot : openSlot;
    this.commitSidebarLayout(changeSlot(state.sidebarLayout, "companion"));
    this.setSessionObserverVisibility(!closing);
  }

  requestSubagentsPanel(intent: "open" | "toggle"): void {
    this.requestBackgroundPanel("subagents", intent);
  }

  /** Opens the Subagents panel on one subagent, or on its list. */
  protected showSubagents(subagentKey: string | null): void {
    const sessionKey = this.state?.sessionKey;
    // The pane owns the intent across the panel's lazy mount; the panel takes
    // it once, and only for the session that asked.
    const take = () => {
      if (this.subagentsShowRequest === take) {
        this.subagentsShowRequest = undefined;
        this.requestUpdate();
      }
      return this.state?.sessionKey === sessionKey ? subagentKey : undefined;
    };
    this.subagentsShowRequest = take;
    this.requestUpdate();
    this.requestBackgroundPanel("subagents", "open");
  }

  /** The layout as this pane shows it, which a narrow pane decides for the background panels. */
  protected presentSidebarLayout(layout: SidebarLayout): SidebarLayout {
    return this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX
      ? presentNarrowSidebarLayout(layout)
      : layout;
  }

  protected isSlotShown(layout: SidebarLayout, slot: SidebarSlotId): boolean {
    return isSidebarSlotVisible(this.presentSidebarLayout(layout), slot);
  }

  protected requestBackgroundPanel(
    slot: "subagents" | "processes",
    intent: "open" | "toggle",
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const closing = intent === "toggle" && isSidebarSlotVisible(state.sidebarLayout, slot);
    if (!closing && this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX) {
      // The panel is about to replace the view this control is in; the region,
      // which may not have loaded yet, carries focus across from it.
      const active = this.ownerDocument.activeElement;
      const origin = active instanceof HTMLElement && this.contains(active) ? active : null;
      const take = () => {
        if (this.sideFocusOrigin === take) {
          this.sideFocusOrigin = undefined;
        }
        return origin;
      };
      this.sideFocusOrigin = take;
    }
    this.commitSidebarLayout(
      closing ? closeSlot(state.sidebarLayout, slot) : openSlot(state.sidebarLayout, slot),
    );
  }

  protected syncSessionCompanionPresentation(presented: boolean): void {
    if (
      this.sessionCompanionPresented === presented &&
      (presented || this.sessionCompanionFocusRequest === undefined)
    ) {
      return;
    }
    this.sessionCompanionPresented = presented;
    if (presented && this.state) {
      this.sessionCompanionFocusRequest ??= this.captureSessionCompanionFocus(
        this.state,
      ).requestFocus;
    } else {
      this.sessionCompanionFocusGeneration += 1;
      this.sessionCompanionFocusRequest = undefined;
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
      (this.ownerDocument.activeElement === this.ownerDocument.body ||
        this.contains(this.ownerDocument.activeElement)) &&
      this.isConnected &&
      this.active &&
      this.visuallyPresented &&
      this.presented;
    const requestFocus = () => {
      if (this.sessionCompanionFocusRequest === requestFocus) {
        this.sessionCompanionFocusRequest = undefined;
        this.requestUpdate();
      }
      return ownsFocus();
    };
    return { ownsFocus, requestFocus };
  }

  protected async openSessionCompanion(pageState: ChatPageHost, question: string): Promise<void> {
    const { ownsFocus, requestFocus } = this.captureSessionCompanionFocus(pageState);
    // The first lazy mount and the completed answer share the same input intent.
    this.sessionCompanionFocusRequest = requestFocus;
    this.requestUpdate();
    await this.submitSessionCompanionQuestion(question);
    if (ownsFocus()) {
      this.sessionCompanionFocusRequest = requestFocus;
      this.requestUpdate();
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
    const ask = (key: string, value: string, requestedAttachments?: ChatAttachment[]) =>
      requestSessionCompanionAnswer(
        client,
        key,
        value,
        agentId,
        requestedAttachments,
        state.uploadConfig,
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
