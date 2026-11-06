import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadOlderChatHistoryPage } from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import { admitChatHistoryPages } from "./chat-history-snapshot.ts";
import { reloadChatHistoryWindow, requiresChatHistoryReload } from "./chat-history.ts";
import { ChatPaneSession } from "./chat-pane-session.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import type { ReplyMessageStatus } from "./components/chat-reply-preview.ts";

registerChatMessageMetadataEnglish();

export abstract class ChatPaneReplyNavigation extends ChatPaneSession {
  private activeReplyNavigation: symbol | null = null;
  private replyNavigationRead: AbortController | null = null;
  replyNavigationSessionKey: string | null = null;
  replyNavigationId: string | null = null;
  protected replyMessageRevision = 0;
  private replyMessageSource: unknown[] | undefined;
  private readonly replyMessages = new Map<
    string,
    { message?: unknown; status?: "missing" | "oversized" }
  >();

  private synchronizeReplyMessages(): void {
    const messages = this.state?.chatMessages;
    if (this.replyMessageSource !== messages) {
      this.replyMessageSource = messages;
      const previous = new Map(this.replyMessages);
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
      // History arrays can change without changing any reply preview. Invalidate
      // mounted rows only when the final lookup facts change, including removals.
      if (
        previous.size !== this.replyMessages.size ||
        [...this.replyMessages].some(([id, current]) => {
          const held = previous.get(id);
          return !held || held.message !== current.message || held.status !== current.status;
        })
      ) {
        this.replyMessageRevision += 1;
      }
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
    // Clearing quoted bodies must invalidate cached previews before the next projection.
    if (this.replyMessages.size) {
      this.replyMessageRevision += 1;
    }
    this.replyMessages.clear();
    this.replyMessageSource = undefined;
  }

  protected resetReplyNavigation(): void {
    this.replyNavigationRead?.abort();
    this.replyNavigationRead = null;
    this.activeReplyNavigation = null;
    this.replyNavigationSessionKey = null;
    this.replyNavigationId = null;
  }

  protected readonly openReplyMessage = async (messageId: string): Promise<void> => {
    const state = this.state;
    if (!state || parseCatalogSessionKey(state.sessionKey)) {
      return;
    }
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId?.trim() ?? "";
    const ownsConnection = captureChatConnectionOwner(state);
    const agentId = resolveChatAgentId(state);
    this.resetReplyNavigation();
    const read = new AbortController();
    this.replyNavigationRead = read;
    const signal = AbortSignal.any([read.signal, this.transcriptReadAbortController.signal]);
    const navigation = Symbol("reply-navigation");
    const isCurrent = () =>
      !signal.aborted &&
      this.activeReplyNavigation === navigation &&
      this.state === state &&
      ownsConnection() &&
      resolveChatAgentId(state) === agentId &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      (!sessionId || state.currentSessionId === sessionId);
    this.activeReplyNavigation = navigation;
    this.replyNavigationSessionKey = sessionKey;
    this.replyNavigationId = messageId;
    try {
      if (!state.chatMessages.some((message) => persistedMessageEntryId(message) === messageId)) {
        // A reply can be beyond either edge. Reopen its producer-owned group
        // directly rather than scanning every older page or guessing exhaustion.
        if (!state.currentSessionId) {
          await reloadChatHistoryWindow(state);
        }
        if (!isCurrent() || !state.currentSessionId) {
          return;
        }
        const result = await loadOlderChatHistoryPage(
          state,
          { messageId, sessionId: state.currentSessionId, limit: 1 },
          signal,
          isCurrent,
        );
        if (!isCurrent()) {
          return;
        }
        if (!result) {
          state.lastError = t("chat.thread.earlierInterrupted");
          return;
        }
        if (requiresChatHistoryReload(result, state.currentSessionId)) {
          await reloadChatHistoryWindow(state);
        } else {
          admitChatHistoryPages(state, [result], "around");
        }
        if (!isCurrent()) {
          return;
        }
        if (!state.chatMessages.some((message) => persistedMessageEntryId(message) === messageId)) {
          state.lastError = t("chat.messages.originalUnavailable");
          return;
        }
      }
      if (!isCurrent()) {
        return;
      }
      await this.awaitDomCommit();
      if (isCurrent()) {
        this.transcript.revealMessage(messageId);
      }
    } catch (error) {
      if (isCurrent()) {
        state.lastError = formatChatHistoryLoadError(error);
      }
    } finally {
      if (this.activeReplyNavigation === navigation) {
        this.resetReplyNavigation();
      }
    }
  };
}
