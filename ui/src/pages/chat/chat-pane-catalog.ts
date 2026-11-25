import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogTranscriptItem,
  SessionCatalogRouteMethods,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { projectCatalogItemForDisplay } from "../../../../src/chat/session-catalog-display.js";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { readCatalogRoute } from "../../lib/sessions/catalog-read-method.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { ChatPaneTaskSuggestions } from "./chat-pane-task-suggestions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { scheduleChatScroll } from "./scroll.ts";

registerChatSessionEnglish();

function isOutboundSessionShare(key: CatalogSessionKey): boolean {
  return key.catalogId === "openclaw" && key.hostId.startsWith("gateway:");
}

export abstract class ChatPaneCatalog extends ChatPaneTaskSuggestions {
  protected readonly catalogAccess = projectChatFields<{
    route?: {
      catalogId: string;
      hello: ApplicationGatewaySnapshot["hello"];
      generation: number;
      methods: SessionCatalogRouteMethods;
    };
  }>({ route: undefined });

  private catalogRead:
    | { controller: AbortController; older: boolean; refresh: boolean }
    | undefined;
  private catalogReadPending = false;
  private catalogReadRefreshPending = false;

  protected retireCatalogRead(resume = false): void {
    const read = this.catalogRead;
    if (!read) {
      if (!resume) {
        this.catalogReadPending = false;
      }
      return;
    }
    this.catalogRead = undefined;
    // Continuation writes share catalogLoadGeneration. Hiding a read must not
    // retire their adopted-send intent or change the reader's pagination.
    this.catalogReadPending = resume && !read.older;
    this.catalogReadRefreshPending = this.catalogReadPending && read.refresh;
    if (!read.older) {
      this.history.catalogLoading = false;
      if (this.state) {
        this.state.chatLoading = false;
      }
    }
    read.controller.abort();
  }

  protected resumeCatalogRead(): void {
    const key = parseCatalogSessionKey(this.state?.sessionKey);
    if (key && this.catalogReadPending) {
      void this.loadCatalogSession(key, false, false, this.catalogReadRefreshPending);
    }
  }

  protected handleCatalogGatewayEvent(event: string): void {
    if (event === "sessions.catalog.routes.changed") {
      const key = parseCatalogSessionKey(this.state?.sessionKey);
      if (key) {
        // A replacement can remove the caller's read grant. Retire the old read
        // and transcript before a foreground or resumed lookup uses the new owner.
        this.retireCatalogRead();
        this.catalogAccess.route = undefined;
        this.history.catalogMessages = [];
        this.history.catalogPreviewImage = undefined;
        this.history.catalogHost = null;
        this.history.catalogSession = null;
        this.history.catalogCursor = undefined;
        this.catalogReadPending = true;
        this.catalogReadRefreshPending = false;
        if (this.secondarySessionReadsReady()) {
          this.resumeCatalogRead();
        }
      }
      return;
    }
    if (
      event !== "terminal.exit" ||
      this.history.catalogSession?.canContinue !== false ||
      this.catalogReadPending
    ) {
      return;
    }
    const key = parseCatalogSessionKey(this.state?.sessionKey);
    if (key) {
      // Recheck provider eligibility without discarding the retained transcript or older pages.
      void this.loadCatalogSession(key, false, !this.history.catalogLoading);
    }
  }
  protected openCatalogSession(key: CatalogSessionKey, state: ChatPageHost) {
    this.catalogLoadGeneration += 1;
    this.catalogRequestedSessionKey = this.sessionKey;
    this.history.catalogMessages = [];
    this.history.catalogPreviewImage = undefined;
    this.history.catalogCursor = undefined;
    this.history.catalogSession = null;
    this.history.catalogHost = null;
    this.catalogAccess.route = undefined;
    // Payload-store entries and their object URLs are reclaimed only by
    // explicit release; clearing the array alone strands them for the tab.
    releaseChatAttachmentPayloads(state.chatAttachments);
    this.chatState.attachmentInputProps(state).onAttachmentsChange([]);
    state.chatLoading = true;
    void this.loadCatalogSession(key, false);
  }

  protected catalogItemMessage(item: SessionCatalogTranscriptItem): Record<string, unknown> | null {
    const timestamp = parseDateStringTimestampMs(item.timestamp);
    const message = projectCatalogItemForDisplay(item);
    if (!message) {
      return null;
    }
    return {
      ...message,
      ...(timestamp == null ? {} : { timestamp }),
      ...(item.type === "userMessage"
        ? {
            senderLabel: item.sender?.label ?? t("sessionsView.user"),
            ...(item.sender
              ? {
                  __openclaw: {
                    ...asOptionalRecord(message["__openclaw"]),
                    senderIdentity: item.sender.identity,
                    senderId: item.sender.identity.id,
                    senderName: item.sender.label,
                    senderProfileAvatarUrl: item.sender.avatarUrl,
                  },
                }
              : {}),
          }
        : {}),
    };
  }

  protected prependUniqueCatalogMessages(messages: unknown[]): unknown[] {
    const seenIds = new Set(this.history.catalogMessages.map(catalogMessageId).filter(Boolean));
    const uniqueMessages = messages.filter((message) => {
      const messageId = catalogMessageId(message);
      if (!messageId || !seenIds.has(messageId)) {
        if (messageId) {
          seenIds.add(messageId);
        }
        return true;
      }
      return false;
    });
    return [...uniqueMessages, ...this.history.catalogMessages];
  }

  async pollCatalogSession(): Promise<boolean> {
    const key = parseCatalogSessionKey(this.state?.sessionKey);
    if (
      !key ||
      !this.secondarySessionReadsReady() ||
      this.catalogRead ||
      !isOutboundSessionShare(key)
    ) {
      return false;
    }
    return this.loadCatalogSession(key, false, false, true);
  }

  protected async loadCatalogSession(
    key: CatalogSessionKey,
    older: boolean,
    metadataOnly = false,
    refresh = false,
  ): Promise<boolean> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return false;
    }
    const { state, client } = scope;
    const snapshot = scope.context.gateway.snapshot;
    if (
      older &&
      (!this.history.catalogCursor || (isOutboundSessionShare(key) && !this.history.catalogSession))
    ) {
      return false;
    }
    this.retireCatalogRead();
    const read = { controller: new AbortController(), older, refresh };
    this.catalogRead = read;
    this.catalogReadPending = false;
    const agentId = resolveChatAgentId(state);
    const profileRelation = this.catalogProfileRelation;
    const relationKey = JSON.stringify(profileRelation);
    const requestedSessionKey = this.sessionKey;
    const isCurrent = () =>
      !read.controller.signal.aborted &&
      this.catalogRead === read &&
      JSON.stringify(this.catalogProfileRelation) === relationKey &&
      this.isConnectionScopeCurrent(scope) &&
      scope.context.gateway.snapshot.hello === snapshot.hello &&
      this.sessionKey === requestedSessionKey &&
      resolveChatAgentId(state) === agentId;
    if (!older && !metadataOnly && !refresh) {
      this.history.catalogLoading = true;
      this.history.catalogCursor = undefined;
      this.olderCursorsSeen.clear();
      this.historyReaderIntent = false;
      this.transcriptScrollTop = null;
    }
    try {
      const previous = this.catalogAccess.route;
      const route =
        previous?.catalogId === key.catalogId &&
        previous.hello === snapshot.hello &&
        previous.generation === scope.generation
          ? previous
          : await readCatalogRoute(
              client,
              snapshot,
              { catalogId: key.catalogId },
              read.controller.signal,
            );
      if (!isCurrent()) {
        return false;
      }
      if (route && route !== previous) {
        this.catalogAccess.route = {
          catalogId: key.catalogId,
          hello: snapshot.hello,
          generation: scope.generation,
          methods: route.methods,
        };
      }
      if (!route?.methods.list || !route.methods.read) {
        this.catalogAccess.route = undefined;
        this.history.catalogSession = null;
        this.history.catalogMessages = [];
        this.history.catalogPreviewImage = undefined;
        state.lastError = t("chat.sessionRoute.catalogShareUnavailable");
        return false;
      }
      if (!older) {
        const lookup = await lookupCatalogSession({
          agentId,
          client,
          key,
          profileRelation,
          isCurrent,
          signal: read.controller.signal,
          listMethod: route.methods.list,
        });
        if (!lookup || !isCurrent()) {
          return false;
        }
        this.history.catalogHost = lookup.host;
        this.history.catalogSession = lookup.session;
        // Absence is not authority to read cached selection. Keep only the poll
        // route so a later bounded lookup can recover without reopening the pane.
        if (
          isOutboundSessionShare(key) &&
          (!lookup.session || !lookup.host?.connected || lookup.host.error)
        ) {
          this.history.catalogSession = null;
          this.history.catalogPreviewImage = undefined;
          state.lastError = t("chat.sessionRoute.catalogShareUnavailable");
          return false;
        }
        if (lookup.session?.previewImageDigest !== this.history.catalogPreviewImage?.digest) {
          this.history.catalogPreviewImage = undefined;
        }
        if (metadataOnly) {
          return true;
        }
      }
      const requestedOlderCursor = older ? this.history.catalogCursor : undefined;
      const wantImage =
        !older &&
        Boolean(this.history.catalogSession?.previewImageDigest) &&
        !this.history.catalogPreviewImage;
      const page = await client.request<SessionsCatalogReadResult>(
        route.methods.read,
        {
          agentId,
          catalogId: key.catalogId,
          hostId: key.hostId,
          threadId: key.threadId,
          ...(profileRelation ? { profileRelation } : {}),
          ...(this.history.catalogSession?.sourceHomeId
            ? { sourceHomeId: this.history.catalogSession.sourceHomeId }
            : {}),
          ...(wantImage ? { includePreviewImage: true } : {}),
          limit: 50,
          ...(older && this.history.catalogCursor ? { cursor: this.history.catalogCursor } : {}),
        },
        { signal: read.controller.signal },
      );
      if (!isCurrent()) {
        return false;
      }
      if (wantImage) {
        this.history.catalogPreviewImage = page.previewImage;
      }
      // Only accepted pages advance progress. A cancelled read must leave its
      // cursor reusable instead of falsely exhausting a later retry.
      if (requestedOlderCursor) {
        this.olderCursorsSeen.add(requestedOlderCursor);
      }
      const messages = page.items
        .toReversed()
        .map((item) => this.catalogItemMessage(item))
        .filter((message) => message !== null);
      // Poll the latest window without dropping already-loaded older history when
      // the complete retained tail still matches. A gap/rewind replaces it and
      // adopts the new window's cursor rather than inventing continuity.
      const firstId = refresh && messages.length > 0 ? catalogMessageId(messages[0]) : undefined;
      const overlap = firstId
        ? this.history.catalogMessages.findIndex((message) => catalogMessageId(message) === firstId)
        : -1;
      const retainedTail = this.history.catalogMessages.slice(overlap);
      const retainedHistory =
        refresh &&
        overlap >= 0 &&
        messages.length >= retainedTail.length &&
        retainedTail.every((message, index) => {
          const id = catalogMessageId(message);
          return id !== null && id === catalogMessageId(messages[index]);
        });
      const nextMessages = older
        ? this.prependUniqueCatalogMessages(messages)
        : retainedHistory
          ? [...this.history.catalogMessages.slice(0, overlap), ...messages]
          : messages;
      const addedMessages = nextMessages.length > this.history.catalogMessages.length;
      // Exhaust when the cursor cannot make new forward progress: absent, unchanged,
      // or already visited this session (a provider cycling c1 -> c2 -> c1). Any of
      // these stops the re-armed observer from looping. An advancing, never-seen
      // cursor with no newly rendered messages (an entirely filtered/duplicate page)
      // must keep paging — real older history may sit behind it.
      const olderExhausted =
        older &&
        (!page.nextCursor ||
          page.nextCursor === requestedOlderCursor ||
          this.olderCursorsSeen.has(page.nextCursor));
      this.history.catalogMessages = nextMessages;
      if (!retainedHistory) {
        this.history.catalogCursor = olderExhausted ? undefined : page.nextCursor;
        if (refresh) {
          this.olderCursorsSeen.clear();
        }
      }
      if (older) {
        this.history.olderError = null;
      } else {
        state.lastError = null;
      }
      scheduleChatScroll(state, !older && !refresh);
      return !older || addedMessages || !olderExhausted;
    } catch (error) {
      if (isCurrent()) {
        if (older) {
          this.history.olderError = formatUiError(error);
        } else {
          this.history.catalogPreviewImage = undefined;
          state.lastError = formatUiError(error);
        }
      }
      return false;
    } finally {
      if (isCurrent() && !older) {
        this.history.catalogLoading = false;
        state.chatLoading = false;
      }
      if (this.catalogRead === read) {
        this.catalogRead = undefined;
      }
    }
  }
}
