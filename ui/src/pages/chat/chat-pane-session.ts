import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { projectCatalogItemForDisplay } from "../../../../src/chat/session-catalog-display.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { collectUnreadHiddenRunRows } from "../../components/app-sidebar-session-parent.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { catalogReadMethod } from "../../lib/sessions/catalog-read-method.ts";
import { resolveSessionKey } from "../../lib/sessions/navigation.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { getAcceptedChatHistorySession } from "./chat-history-state.ts";
import { ChatPaneTaskSuggestions } from "./chat-pane-task-suggestions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";
import { scheduleChatScroll } from "./scroll.ts";

registerChatSessionEnglish();

export abstract class ChatPaneSession extends ChatPaneTaskSuggestions {
  deferredSessionHydration: { resume?: () => void } | null = null;
  private catalogRead: { controller: AbortController; older: boolean } | undefined;
  private catalogReadPending = false;

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
      void this.loadCatalogSession(key, false);
    }
  }

  protected handleCatalogGatewayEvent(event: string): void {
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
  /** Hidden-run acknowledgements in flight or sent, keyed by run and activity revision. */
  private readonly hiddenRunReadRequests = new Map<
    string,
    { revision: number | null; guard: SessionUnreadPatchGuard }
  >();

  protected resetSessionReadAcknowledgements(): void {
    this.unreadPatchGuard.beginActivation(this.state?.sessionKey ?? "");
    this.hiddenRunReadRequests.clear();
  }

  protected secondarySessionReadsReady(explicit = false): boolean {
    const state = this.state;
    return Boolean(
      state?.connected &&
      isGatewayAvailable(this.context.gateway.snapshot) &&
      this.presented &&
      document.visibilityState !== "hidden" &&
      (explicit ||
        (!this.deferredSessionHydration &&
          (parseCatalogSessionKey(state.sessionKey) ||
            this.transcriptReady ||
            getAcceptedChatHistorySession(state)))),
    );
  }

  protected deferSessionHydrationUntilTranscript(
    sessionKey: string,
    transcriptLoad: Promise<boolean>,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const hydration: NonNullable<ChatPaneSession["deferredSessionHydration"]> = {};
    this.deferredSessionHydration = hydration;
    const connectionGeneration = this.connectionGeneration;
    const client = state.client;
    const retireIfCurrent = () => {
      if (this.deferredSessionHydration === hydration) {
        this.deferredSessionHydration = null;
      }
    };
    const isCurrent = () =>
      this.deferredSessionHydration === hydration &&
      this.connectionGeneration === connectionGeneration &&
      this.state === state &&
      state.connected &&
      state.client === client &&
      state.sessionKey === sessionKey;
    const scheduleHydration = (historyCommitted: boolean) => {
      if (!isCurrent()) {
        retireIfCurrent();
        return;
      }
      if (historyCommitted) {
        this.cacheSessionReactions();
      }
      if (!this.presented || document.visibilityState === "hidden") {
        hydration.resume = () => scheduleHydration(historyCommitted);
        return;
      }
      hydration.resume = undefined;
      // These affordances do not shape the transcript. Start them together only
      // after the transcript paints; a DOM commit still runs before the browser can paint.
      scheduleControlUiAfterPaint(state, () => {
        if (isCurrent() && this.presented && document.visibilityState !== "hidden") {
          this.deferredSessionHydration = null;
          this.syncSessionReactions();
          void this.refreshTaskSuggestions({ automatic: true });
          if (historyCommitted) {
            this.markSessionRead(selectedChatSessionRow(state));
          }
          if (client) {
            void this.loadHeaderPlatform(client, connectionGeneration);
          }
          void loadChatBranches(state);
          void this.probeSessionDiscussion(sessionKey);
          this.hydrateSessionCompanion(sessionKey);
        } else if (isCurrent()) {
          hydration.resume = () => scheduleHydration(historyCommitted);
        } else {
          retireIfCurrent();
        }
      });
    };
    void transcriptLoad.then(scheduleHydration, () => scheduleHydration(false));
  }

  protected resumeDeferredSessionHydration(): boolean {
    const hydration = this.deferredSessionHydration;
    if (hydration) {
      const resume = hydration.resume;
      hydration.resume = undefined;
      resume?.();
    }
    return this.deferredSessionHydration !== null;
  }

  protected retireDeferredSessionHydration(): void {
    this.deferredSessionHydration = null;
  }

  protected markSessionRead(row: GatewaySessionRow | undefined) {
    const state = this.state;
    if (!state || !row || !this.secondarySessionReadsReady()) {
      return;
    }
    const failureAt = row.endedAt ?? row.updatedAt ?? 0;
    const unreadFailure =
      (row.status === "failed" || row.status === "timeout") &&
      (row.lastReadAt == null || failureAt > row.lastReadAt);
    const agentStatusActive = Boolean(row.agentStatus && row.agentStatus.expiresAt > Date.now());
    const unread = row.unread === true || unreadFailure || agentStatusActive;
    if (!unread) {
      this.unreadPatchGuard.shouldPatch(state.sessionKey, false, row.markedUnreadAt);
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? resolveChatAgentId(state);
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, unread: false, agentId },
      sessionScope: true,
      session: row,
    });
    // Read-only navigation must remain silent: absence of mutation access is
    // not an operation failure and should not latch the unread retry guard.
    if (
      !access.allowed ||
      // Shared visibility can still be capped to viewing by the caller's role.
      row.sharingRole === "viewer" ||
      this.sessionParticipationTracker.resolve({
        catalog: parseCatalogSessionKey(state.sessionKey) !== null,
        listLoading: state.sessionsLoading,
        sessionKey: `${resolveChatAgentId(state) ?? ""}\0${state.sessionKey}`,
        session: row,
      })
    ) {
      return;
    }
    // Hidden runs fold their unread state into this row, even after it was read.
    this.markHiddenRunsRead(row);
    if (!unread || !this.unreadPatchGuard.shouldPatch(state.sessionKey, true, row.markedUnreadAt)) {
      return;
    }
    this.acknowledgeSessionRead(row, this.unreadPatchGuard, agentId);
  }

  private acknowledgeSessionRead(
    row: GatewaySessionRow,
    guard: SessionUnreadPatchGuard,
    agentId: string | undefined,
  ) {
    const state = this.state;
    const sessionKey = state?.sessionKey;
    const settle = guard.settlePatch();
    void this.context.sessions
      .patch(
        row.key,
        { unread: false },
        { agentId, expectedMarkedUnreadAt: row.markedUnreadAt ?? null },
      )
      .then(
        (result) => {
          if (
            settle(result !== null) &&
            result !== null &&
            state &&
            this.state === state &&
            state.sessionKey === sessionKey
          ) {
            this.markSessionRead(selectedChatSessionRow(state));
          }
        },
        (error: unknown) => settle(false, error),
      );
  }

  private markHiddenRunsRead(parent: GatewaySessionRow) {
    const state = this.state;
    if (!state) {
      return;
    }
    const runs = collectUnreadHiddenRunRows(state.sessionsResult?.sessions ?? [], parent.key);
    const pending: GatewaySessionRow[] = [];
    const settlements = new Map<string, ReturnType<SessionUnreadPatchGuard["settlePatch"]>>();
    for (const run of runs) {
      const revision = run.updatedAt ?? null;
      // Manual unread markers stay until the run itself is acknowledged.
      if (run.markedUnreadAt != null || run.sharingRole === "viewer") {
        continue;
      }
      const agentId = parseAgentSessionKey(run.key)?.agentId ?? resolveChatAgentId(state);
      const access = readSessionMethodAccess(this.context.gateway.snapshot, {
        method: "sessions.patchMany",
        params: { targets: [{ key: run.key, agentId }], patch: { unread: false } },
        sessionScope: true,
        session: run,
      });
      if (!access.allowed) {
        continue;
      }
      let request = this.hiddenRunReadRequests.get(run.key);
      if (!request || request.revision !== revision) {
        request = { revision, guard: new SessionUnreadPatchGuard() };
        this.hiddenRunReadRequests.set(run.key, request);
      }
      if (request.guard.shouldPatch(run.key, true)) {
        pending.push(run);
        settlements.set(run.key, request.guard.settlePatch());
      }
    }
    if (pending.length === 0) {
      return;
    }
    const sessionKey = state.sessionKey;
    void this.context.sessions
      .acknowledgeHiddenRuns(pending, {
        agentId: resolveChatAgentId(state),
      })
      .then(
        (outcomes) => {
          let acknowledged = false;
          for (const outcome of outcomes) {
            if (settlements.get(outcome.key)?.(outcome.ok, outcome.error) && outcome.ok) {
              acknowledged = true;
            }
          }
          if (acknowledged && this.state === state && state.sessionKey === sessionKey) {
            this.markSessionRead(selectedChatSessionRow(state));
          }
        },
        (error: unknown) => {
          for (const settle of settlements.values()) {
            settle(false, error);
          }
        },
      );
  }

  protected async restoreArchivedSession(sessionKey: string, expectedSessionId: string) {
    const scope = this.captureConnectionScope();
    if (!scope || scope.state.sessionKey !== sessionKey) {
      return;
    }
    const access = readSessionMethodAccess(scope.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, archived: false },
      sessionScope: true,
      session: selectedChatSessionRow(scope.state),
    });
    if (!access.allowed) {
      scope.state.lastError = access.reason;
      scope.state.chatError = access.reason;
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? resolveChatAgentId(scope.state);
    let failure: string | null = null;
    try {
      // The patch can resolve falsy on failure; the capability error explains it.
      const patched = await scope.sessions.patch(
        sessionKey,
        { archived: false },
        { agentId, expectedSessionId },
      );
      if (!patched) {
        failure = scope.sessions.state.error;
      }
    } catch (error) {
      failure = formatUiError(error);
    }
    if (failure && this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
      scope.state.lastError = failure;
      scope.state.chatError = failure;
    }
  }

  protected setPaneSessionKey(sessionKey: string): string | null {
    const state = this.state;
    if (!state) {
      return null;
    }
    const nextSessionKey = parseCatalogSessionKey(sessionKey)
      ? sessionKey
      : resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return null;
    }
    state.sessionKey = nextSessionKey;
    return nextSessionKey;
  }

  protected openCatalogSession(key: CatalogSessionKey, state: ChatPageHost) {
    this.catalogRequestedSessionKey = this.sessionKey;
    this.history.catalogMessages = [];
    this.history.catalogCursor = undefined;
    this.history.catalogSession = null;
    this.history.catalogHost = null;
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

  protected async loadCatalogSession(
    key: CatalogSessionKey,
    older: boolean,
    metadataOnly = false,
  ): Promise<boolean> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return false;
    }
    const { state, client } = scope;
    if (older && !this.history.catalogCursor) {
      return false;
    }
    this.retireCatalogRead();
    const read = { controller: new AbortController(), older };
    this.catalogRead = read;
    this.catalogReadPending = false;
    const agentId = resolveChatAgentId(state);
    const requestedSessionKey = this.sessionKey;
    const isCurrent = () =>
      !read.controller.signal.aborted &&
      this.catalogRead === read &&
      this.isConnectionScopeCurrent(scope) &&
      this.sessionKey === requestedSessionKey &&
      resolveChatAgentId(state) === agentId;
    if (!older && !metadataOnly) {
      this.history.catalogLoading = true;
      this.history.catalogCursor = undefined;
      this.olderCursorsSeen.clear();
      this.historyObserverArmed = false;
      this.transcriptScrollTop = null;
      this.historyObserver?.disconnect();
      this.historyObserver = null;
    }
    try {
      if (!older) {
        const lookup = await lookupCatalogSession({
          agentId,
          client,
          key,
          isCurrent,
          signal: read.controller.signal,
          listMethod: catalogReadMethod(scope.context.gateway.snapshot, key.catalogId, "list"),
        });
        if (!lookup || !isCurrent()) {
          return false;
        }
        this.history.catalogHost = lookup.host;
        this.history.catalogSession = lookup.session;
        if (metadataOnly) {
          return true;
        }
      }
      const requestedOlderCursor = older ? this.history.catalogCursor : undefined;
      const page = await client.request<SessionsCatalogReadResult>(
        catalogReadMethod(scope.context.gateway.snapshot, key.catalogId, "read"),
        {
          agentId,
          catalogId: key.catalogId,
          hostId: key.hostId,
          threadId: key.threadId,
          ...(this.history.catalogSession?.sourceHomeId
            ? { sourceHomeId: this.history.catalogSession.sourceHomeId }
            : {}),
          limit: 50,
          ...(older && this.history.catalogCursor ? { cursor: this.history.catalogCursor } : {}),
        },
        { signal: read.controller.signal },
      );
      if (!isCurrent()) {
        return false;
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
      const nextMessages = older ? this.prependUniqueCatalogMessages(messages) : messages;
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
      this.history.catalogCursor = olderExhausted ? undefined : page.nextCursor;
      if (older) {
        this.history.olderError = null;
      } else {
        state.lastError = null;
      }
      scheduleChatScroll(state, !older);
      return !older || addedMessages || !olderExhausted;
    } catch (error) {
      if (isCurrent()) {
        if (older) {
          this.history.olderError = formatUiError(error);
        } else {
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
