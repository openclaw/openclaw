import { t } from "../../i18n/index.ts";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { hasVisibleOlderHistoryPage } from "./chat-history-page-visibility.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  type ChatHistoryRequestBudget,
} from "./chat-history-request-params.ts";
import {
  createChatHistoryPageRead,
  chatHistoryPageSelector,
  isStagedOlderHistoryPageCurrent,
  type StagedOlderHistoryPage,
} from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import {
  admitChatHistoryPages,
  prepareChatHistoryPages,
  reopenChatHistoryBoundary,
  resolveChatHistoryPagination,
} from "./chat-history-snapshot.ts";
import { chatHistoryWindowBoundary, MAX_RESIDENT_SEGMENTS } from "./chat-history-window.ts";
import { reloadChatHistoryWindow, requiresChatHistoryReload } from "./chat-history.ts";
import { ChatPaneSnapshotHydration } from "./chat-pane-snapshot-hydration.ts";
import { readChatHistoryRequestBudget } from "./history-merge.ts";
import { scheduleChatScroll } from "./scroll.ts";

export abstract class ChatPaneHistoryPackets extends ChatPaneSnapshotHydration {
  // One bounded reply may wait after an admission or capacity stop. Its root
  // claim is revalidated on consumption; reset/hide/retirement replace this owner.
  // Catalog pages keep their separate reactive lifecycle and never enter this slot.
  protected stagedHistory: {
    controller: AbortController;
    direction?: "older" | "newer";
    page: StagedOlderHistoryPage | null;
    load: Promise<void> | null;
    capacityNotice?: string;
  } = { controller: new AbortController(), page: null, load: null };

  protected async loadNativeHistoryPackets(
    state: NonNullable<ChatPaneHistoryPackets["state"]>,
    direction: "older" | "newer",
    readerIntent: boolean,
    signal: AbortSignal,
    ownsIntent: () => boolean,
  ): Promise<boolean> {
    const owner = this.stagedHistory;
    const take = () => {
      const page = owner.page;
      owner.page = null;
      return page &&
        owner.direction === direction &&
        isStagedOlderHistoryPageCurrent(state, page, page.requestedCursor, direction)
        ? page
        : null;
    };
    let staged = take();
    if (!staged && owner.direction === direction && owner.load) {
      if (direction === "older") {
        this.history.loadingOlder = true;
      }
      await owner.load;
      if (!ownsIntent()) {
        return false;
      }
      staged = take();
    }
    const read = createChatHistoryPageRead(state);
    if (!read) {
      return false;
    }
    const sessionId = state.currentSessionId?.trim() ?? "";
    const edge = () =>
      direction === "older"
        ? state.chatHistoryPagination.hasMore && state.chatHistoryPagination.olderCursor
        : state.chatHistoryPagination.newerCursor;
    let root = edge();
    const settleForegroundRead = () => {
      if (signal.aborted || !ownsIntent() || owner !== this.stagedHistory) {
        return false;
      }
      if (read.isCurrent() && edge() === root) {
        return true;
      }
      // A refresh retires this private chain, not the reader's action. Keep its
      // retry outcome visible; retired consumers never publish into successors.
      this.recordHistoryPacketFailure(
        state,
        direction,
        new Error(t("chat.thread.earlierInterrupted")),
      );
      return false;
    };
    const packets: StagedOlderHistoryPage[] = [];
    let overflow: StagedOlderHistoryPage | null = null;
    let failure: unknown;
    let capacityBlocked = false;
    let coverageAdvanced = false;
    let sparse = 0;
    let smallOnly = false;
    const large = (page: StagedOlderHistoryPage) =>
      !page.result.packet?.boundedPacket &&
      ((page.result.requestBudget?.limit ?? 0) > CHAT_HISTORY_REQUEST_LIMIT ||
        (page.result.requestBudget?.maxBytes ?? 0) > CHAT_HISTORY_REQUEST_MAX_BYTES);
    try {
      let selector = chatHistoryPageSelector(state, direction);
      if (!selector || (!readerIntent && "messageId" in selector)) {
        return false;
      }
      let budget =
        readerIntent && !staged && "cursor" in selector
          ? readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], direction))
          : undefined;
      for (let packet = 0; packet < (readerIntent ? MAX_RESIDENT_SEGMENTS : 1); packet++) {
        const requestedCursor: string = "cursor" in selector ? selector.cursor : "";
        const boundary =
          "messageId" in selector
            ? nativeHistoryMessageSourceIdentity(
                chatHistoryWindowBoundary(
                  state.chatMessages,
                  state.chatHistoryPagination,
                  direction,
                ),
              )
            : null;
        if (!staged && direction === "older" && packets.length === 0) {
          this.history.loadingOlder = true;
        }
        const limit = staged?.limit ?? ("limit" in selector ? selector.limit : undefined);
        let result = staged?.result ?? (await read.read(selector, signal, budget));
        staged = null;
        if (!settleForegroundRead()) {
          return false;
        }
        if (!result) {
          throw new Error(t("chat.thread.earlierInterrupted"));
        }
        smallOnly ||= result.smallOnly === true;
        if (requiresChatHistoryReload(result, sessionId, boundary)) {
          owner.page = null;
          owner.controller.abort();
          this.stagedHistory = { controller: new AbortController(), page: null, load: null };
          try {
            await reloadChatHistoryWindow(state);
          } catch (error) {
            // Our own reload retires the packet owner/version. Its failure
            // still belongs to the current reader intent.
            if (ownsIntent() && !signal.aborted) {
              this.recordHistoryPacketFailure(state, direction, error);
            }
            return false;
          }
          return true;
        }
        const next = resolveChatHistoryPagination(
          result,
          state.chatHistoryPagination.totalMessages,
        );
        if (boundary) {
          reopenChatHistoryBoundary(state, boundary, next, direction);
          coverageAdvanced = true;
          root = edge();
          if (
            ++sparse >= (readerIntent ? 3 : 1) ||
            !(direction === "older" ? next.hasMore : next.hasNewer)
          ) {
            break;
          }
          selector = chatHistoryPageSelector(state, direction);
          if (!selector) {
            break;
          }
          budget =
            readerIntent && !smallOnly && "cursor" in selector
              ? readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], direction))
              : undefined;
          continue;
        }
        const cursor = direction === "older" ? next.hasMore && next.olderCursor : next.newerCursor;
        if (cursor === requestedCursor) {
          throw new Error("History returned the same boundary. Reload the session to retry.");
        }
        let page: StagedOlderHistoryPage | null = {
          claim: read.claim,
          requestedCursor,
          result,
          ...(limit ? { limit } : {}),
        };
        let results = [...packets.map((entry) => entry.result), result];
        let prepared: ReturnType<typeof prepareChatHistoryPages> | undefined =
          prepareChatHistoryPages(state, results, direction);
        if (!prepared.fits) {
          // Async continuations can retain loop-local bindings after continue.
          // Release the rejected merged array before any narrower await.
          prepared = undefined;
          if (large(page)) {
            // Reader/pin custody can change during the reply. Refit the accepted
            // prefix; only a strictly smaller numeric envelope crosses the await.
            const issued = page.result.requestBudget;
            const narrower: ChatHistoryRequestBudget | undefined =
              readerIntent && !smallOnly
                ? readChatHistoryRequestBudget(
                    state,
                    prepareChatHistoryPages(
                      state,
                      packets.map((entry) => entry.result),
                      direction,
                    ),
                  )
                : undefined;
            budget =
              issued &&
              narrower &&
              narrower.limit <= issued.limit &&
              narrower.maxBytes <= issued.maxBytes &&
              (narrower.limit < issued.limit || narrower.maxBytes < issued.maxBytes)
                ? narrower
                : undefined;
            smallOnly ||= !budget;
            selector = { cursor: requestedCursor };
            result = undefined;
            page = null;
            results = [];
            continue;
          }
          if (!packets.length && !limit) {
            // Discard this body before awaiting a narrower read from the same
            // authoritative edge; rejected replies never certify coverage.
            selector = { cursor: requestedCursor, limit: 1 };
            result = undefined;
            page = null;
            results = [];
            continue;
          }
          overflow = page;
          if (!packets.length) {
            capacityBlocked = true;
            failure = new Error(t("chat.thread.historyCapacity"));
          }
          break;
        }
        packets.push(page);
        const visible = hasVisibleOlderHistoryPage(state, this.paneId, result.messages ?? []);
        if (!visible && ++sparse >= (readerIntent ? 3 : 1)) {
          break;
        }
        if (!cursor) {
          break;
        }
        selector = { cursor };
        // Reuse this fit's facts synchronously; only numeric bounds cross the
        // next await. Changed live/reader custody is checked again on arrival.
        budget =
          readerIntent && !smallOnly ? readChatHistoryRequestBudget(state, prepared) : undefined;
        prepared = undefined;
      }
    } catch (error) {
      if (!settleForegroundRead()) {
        return false;
      }
      failure = error;
    }
    if (!settleForegroundRead()) {
      return false;
    }
    // Reader/live publication may have changed capacity during a later reply.
    // Keep a fitting contiguous prefix. Only an original small packet may wait
    // in the staged slot; discarded broad bodies never advance an opaque edge.
    while (
      packets.length &&
      !prepareChatHistoryPages(
        state,
        packets.map((page) => page.result),
        direction,
      ).fits
    ) {
      const rejected = packets.pop()!;
      overflow = large(rejected) ? null : rejected;
      if (!packets.length && !overflow) {
        capacityBlocked = true;
        failure = new Error(t("chat.thread.historyCapacity"));
      }
    }
    // Exhausting bounded retries without admission or a reopened edge still
    // needs a visible outcome, even when every broad body was discarded.
    if (!packets.length && !failure && (overflow || !coverageAdvanced)) {
      capacityBlocked = true;
      failure = new Error(t("chat.thread.historyCapacity"));
    }
    const admitted =
      packets.length &&
      admitChatHistoryPages(
        state,
        packets.map((page) => page.result),
        direction,
      );
    owner.direction = direction;
    owner.page = overflow;
    if (admitted) {
      if (owner.capacityNotice && state.lastError === owner.capacityNotice) {
        state.lastError = null;
      }
      delete owner.capacityNotice;
      scheduleChatScroll(state, false);
    }
    if (failure) {
      this.recordHistoryPacketFailure(state, direction, failure);
      if (capacityBlocked && direction === "newer") {
        owner.capacityNotice = state.lastError ?? undefined;
      }
    } else if (admitted && readerIntent && !overflow) {
      this.stageNextHistoryPage(state, direction);
    }
    return Boolean(admitted || (coverageAdvanced && !failure));
  }

  protected recordHistoryPacketFailure(
    state: NonNullable<ChatPaneHistoryPackets["state"]>,
    direction: "older" | "newer",
    error: unknown,
  ): void {
    if (direction === "newer") {
      state.lastError = formatChatHistoryLoadError(error);
      return;
    }
    this.history.olderError = formatChatHistoryLoadError(error);
    this.historyAutoLoadBlocked = true;
    // Loading-row removal must not masquerade as renewed reader input.
    this.transcriptScrollTop = this.transcript.scrollElement?.scrollTop ?? null;
  }

  private stageNextHistoryPage(
    state: NonNullable<ChatPaneHistoryPackets["state"]>,
    direction: "older" | "newer",
  ): void {
    const owner = this.stagedHistory;
    if (owner.page || owner.load) {
      return;
    }
    const pagination = state.chatHistoryPagination;
    const cursor =
      direction === "older" ? pagination.hasMore && pagination.olderCursor : pagination.newerCursor;
    if (!cursor) {
      return;
    }
    const read = createChatHistoryPageRead(state, true);
    if (!read) {
      return;
    }
    owner.direction = direction;
    owner.load = (async () => {
      try {
        const result = await read.read({ cursor }, owner.controller.signal);
        if (result && owner === this.stagedHistory && this.state === state && read.isCurrent()) {
          owner.page = { claim: read.claim, requestedCursor: cursor, result };
        }
      } catch {
        // A speculative failure is silent; a foreground chain reports its own.
      } finally {
        if (owner === this.stagedHistory) {
          owner.load = null;
        }
      }
    })();
  }
}
