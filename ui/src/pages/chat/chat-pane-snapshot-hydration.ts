import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { mergeStoredChatSessionSnapshot } from "./chat-board-snapshot.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { chatHistoryRequests, type InitialChatSnapshotHydration } from "./chat-history-state.ts";
import { ChatPaneReplyNavigation } from "./chat-pane-reply-navigation.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { snapshotStoreGeneration } from "./session-snapshot-invalidation-events.ts";

export abstract class ChatPaneSnapshotHydration extends ChatPaneReplyNavigation {
  protected hydrateStoredChatSnapshot(
    state: NonNullable<ChatPaneSnapshotHydration["state"]>,
    sessionKey: string,
  ): void {
    if (!this.sessionSnapshotStore) {
      return;
    }
    const target = { sessionKey };
    const cache = state.chatMessagesBySession;
    const cacheKey = resolveChatSnapshotKey(state, target);
    const generation = snapshotStoreGeneration;
    const requests = chatHistoryRequests(state);
    const isCurrent = () =>
      requests.initialSnapshotHydration === hydration &&
      generation === snapshotStoreGeneration &&
      this.state === state &&
      this.ownsChatSnapshot(target) &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      resolveChatSnapshotKey(state, target) === cacheKey;
    const restoreBoard = async (storedBoard: ChatSessionSnapshot["board"]) => {
      let { board = storedBoard } = readChatSessionSnapshot(cache, state, target) ?? {};
      if (!board) {
        return;
      }
      const gateway = this.context.gateway.snapshot;
      if (gateway.client && gateway.phase !== "connected") {
        // Let connect leave before the cached dashboard's first render.
        await gateway.client.initialConnectSent;
        // A live board or removal can supersede the cached receipt while waiting.
        ({ board = storedBoard } = readChatSessionSnapshot(cache, state, target) ?? {});
      }
      if (isCurrent() && board) {
        this.resolveBoardProvider();
        this.boardProviderLease?.restoreSnapshot(board.snapshot, board.receivedAtMs);
      }
    };
    const adoptSnapshot = (storedSnapshot: ChatSessionSnapshot | null) => {
      if (!isCurrent()) {
        return;
      }
      const cached = mergeStoredChatSessionSnapshot(cache, state, target, storedSnapshot);
      if (requests.acceptedHistory || !cached) {
        return;
      }
      applyChatCacheSnapshot(state, cached);
      cacheChatSessionSnapshot(cache, state, target, { ...cached, messages: state.chatMessages });
      this.syncSessionReactions();
      if (cached.progressCard !== undefined) {
        const progressTarget = this.resolveChatReadTarget();
        if (progressTarget) {
          this.progressCards.hydrate(progressTarget, cached.progressCard);
        }
      }
    };
    const hydration: InitialChatSnapshotHydration = {
      titlePending: true,
      sessionKey,
      connected: this.context.gateway.snapshot.phase === "connected",
      promise: Promise.resolve(),
    };
    requests.initialSnapshotHydration = projectChatFields(hydration, ["titlePending"]);
    // A validated boot read joins header, composer, and transcript in the first pane frame.
    const ready = this.sessionSnapshotStore.readReady(cacheKey);
    if (ready) {
      adoptSnapshot(ready);
    }
    hydration.promise = (
      ready
        ? Promise.resolve(ready)
        : this.sessionSnapshotStore
            .read(cacheKey, (board) => void restoreBoard(board))
            .then((snapshot) => {
              adoptSnapshot(snapshot);
              return snapshot;
            })
    )
      .then((snapshot) => restoreBoard(snapshot?.board))
      .catch(() => undefined)
      .finally(() => {
        hydration.titlePending = false;
        if (requests.initialSnapshotHydration === hydration) {
          delete requests.initialSnapshotHydration;
        }
      });
  }
}
