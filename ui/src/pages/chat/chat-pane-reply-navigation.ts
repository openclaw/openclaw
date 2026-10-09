import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { ChatPaneSession } from "./chat-pane-session.ts";
import { persistedMessageEntryId } from "./chat-thread.ts";
import type { ReplyMessageStatus } from "./components/chat-reply-preview.ts";

registerChatMessageMetadataEnglish();

export abstract class ChatPaneReplyNavigation extends ChatPaneSession {
  private activeReplyNavigation: symbol | null = null;
  private replyNavigationSessionKey: string | null = null;
  protected replyNavigationId: string | null = null;
  protected replyMessageRevision = 0;
  private replyMessageSource: unknown[] | undefined;
  private readonly replyMessages = new Map<
    string,
    { message?: unknown; status?: "missing" | "oversized" }
  >();

  protected abstract loadOlderMessages(): Promise<boolean>;

  private synchronizeReplyMessages(): void {
    const messages = this.state?.chatMessages;
    if (this.replyMessageSource !== messages) {
      this.replyMessageSource = messages;
      this.replyMessages.clear();
      for (const message of messages ?? []) {
        const target = normalizeMessage(message).replyTarget;
        const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
        const result = asOptionalRecord(meta?.replyToMessage);
        if (target?.kind !== "id" || !result) {
          continue;
        }
        this.replyMessages.set(
          target.id,
          result.ok && result.message
            ? { message: result.message }
            : { status: result.unavailableReason === "oversized" ? "oversized" : "missing" },
        );
      }
      this.replyMessageRevision += 1;
    }
  }

  private currentReplyMessage(messageId: string) {
    this.synchronizeReplyMessages();
    return this.replyMessages.get(messageId);
  }

  protected readonly readReplyMessage = (messageId: string): unknown =>
    this.currentReplyMessage(messageId)?.message;

  protected readonly replyMessageStatus = (messageId: string): ReplyMessageStatus | undefined => {
    const cached = this.currentReplyMessage(messageId);
    return cached?.message ? undefined : (cached?.status ?? "pending");
  };

  protected readonly openReplyMessage = (messageId: string): void => {
    void this.navigateToReplyMessage(messageId);
  };

  protected currentReplyNavigationId(sessionKey: string): string | null {
    return this.replyNavigationSessionKey &&
      areUiSessionKeysEquivalent(this.replyNavigationSessionKey, sessionKey)
      ? this.replyNavigationId
      : null;
  }

  protected currentReplyMessageAccess(sessionKey: string) {
    this.synchronizeReplyMessages();
    return {
      revision: this.replyMessageRevision,
      navigationId: this.currentReplyNavigationId(sessionKey),
      read: this.readReplyMessage,
      status: this.replyMessageStatus,
      open: this.openReplyMessage,
    };
  }

  protected retireReplyMessages(): void {
    this.replyMessages.clear();
    this.replyMessageSource = undefined;
  }

  protected resetReplyNavigation(): void {
    this.activeReplyNavigation = null;
    this.replyNavigationSessionKey = null;
    this.replyNavigationId = null;
  }

  private async navigateToReplyMessage(messageId: string): Promise<void> {
    const state = this.state;
    if (!state || parseCatalogSessionKey(state.sessionKey)) {
      return;
    }
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId?.trim() ?? "";
    const navigation = Symbol("reply-navigation");
    const isCurrent = () =>
      this.activeReplyNavigation === navigation &&
      this.state === state &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      (!sessionId || state.currentSessionId === sessionId);
    this.activeReplyNavigation = navigation;
    this.replyNavigationSessionKey = sessionKey;
    this.replyNavigationId = messageId;
    this.requestUpdate();
    try {
      while (
        !state.chatMessages.some((message) => persistedMessageEntryId(message) === messageId)
      ) {
        if (!isCurrent()) {
          return;
        }
        if (!state.chatHistoryPagination.hasMore) {
          state.lastError = t("chat.messages.originalUnavailable");
          state.requestUpdate?.();
          return;
        }
        const loaded = await this.loadOlderMessages();
        if (!isCurrent()) {
          return;
        }
        if (!loaded) {
          if (!state.chatHistoryPagination.hasMore && !state.lastError) {
            state.lastError = t("chat.messages.originalUnavailable");
            state.requestUpdate?.();
          }
          return;
        }
      }
      if (!isCurrent()) {
        return;
      }
      this.requestUpdate();
      await this.updateComplete;
      if (isCurrent()) {
        this.transcript.revealMessage(messageId);
      }
    } finally {
      if (this.activeReplyNavigation === navigation) {
        this.resetReplyNavigation();
        this.requestUpdate();
      }
    }
  }
}
