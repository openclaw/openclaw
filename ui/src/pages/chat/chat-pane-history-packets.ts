import { racePromiseWithAbortSignal } from "@openclaw/retry";
import { t } from "../../i18n/index.ts";
import {
  createChatHistoryPageRead,
  loadChatHistoryPageRuntime,
  readChatHistoryPageRuntime,
  isStagedOlderHistoryPageCurrent,
} from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import type {
  ChatHistoryPacketOperation,
  ChatHistoryPacketOwner,
} from "./chat-pane-history-packets.runtime.ts";
import { ChatPaneSnapshotHydration } from "./chat-pane-snapshot-hydration.ts";

export abstract class ChatPaneHistoryPackets extends ChatPaneSnapshotHydration {
  // One bounded reply may wait after an admission or capacity stop. Its root
  // claim is revalidated on consumption; reset/hide/retirement replace this owner.
  // Catalog pages keep their separate reactive lifecycle and never enter this slot.
  protected stagedHistory: ChatHistoryPacketOwner = {
    controller: new AbortController(),
    page: null,
    load: null,
  };

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
    const operation: ChatHistoryPacketOperation = {
      state,
      paneId: this.paneId,
      direction,
      readerIntent,
      signal,
      owner,
      read,
      staged,
      sessionId,
      root: edge(),
      edge,
      history: this.history,
      ownsIntent,
      isOwnerCurrent: () => owner === this.stagedHistory && this.state === state,
      replaceOwner: () => {
        owner.page = null;
        owner.controller.abort();
        this.stagedHistory = { controller: new AbortController(), page: null, load: null };
      },
      recordFailure: (error) => this.recordHistoryPacketFailure(state, direction, error),
      settleForegroundRead: () => {
        if (signal.aborted || !ownsIntent() || owner !== this.stagedHistory) {
          return false;
        }
        if (read.isCurrent() && edge() === operation.root) {
          return true;
        }
        // A refresh retires this private chain, not the current reader intent.
        this.recordHistoryPacketFailure(
          state,
          direction,
          new Error(t("chat.thread.earlierInterrupted")),
        );
        return false;
      },
    };
    let runtime = readChatHistoryPageRuntime();
    if (!runtime) {
      if (direction === "older" && !staged) {
        this.history.loadingOlder = true;
      }
      try {
        // Cancel the caller's captured pane/body custody while the module-only
        // download continues; warm paging enters the runtime without this await.
        runtime = await racePromiseWithAbortSignal(
          loadChatHistoryPageRuntime(),
          AbortSignal.any([signal, owner.controller.signal]),
        );
      } catch (error) {
        if (operation.settleForegroundRead()) {
          operation.recordFailure(error);
        }
        return false;
      }
    }
    return operation.settleForegroundRead()
      ? runtime.loadPreparedChatHistoryPackets(operation)
      : false;
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
  }
}
