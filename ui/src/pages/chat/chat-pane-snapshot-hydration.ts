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
    const restoreBoard = (storedBoard: ChatSessionSnapshot["board"]) => {
      const { board = storedBoard } = readChatSessionSnapshot(cache, state, target) ?? {};
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
      if (!requests.acceptedHistory && cached) {
        applyChatCacheSnapshot(state, cached);
        cacheChatSessionSnapshot(cache, state, target, { ...cached, messages: state.chatMessages });
        this.syncSessionReactions();
        if (cached.progressCard !== undefined) {
          const progressTarget = this.resolveChatReadTarget();
          if (progressTarget) {
            this.progressCards.hydrate(progressTarget, cached.progressCard);
          }
        }
      }
      restoreBoard(storedSnapshot?.board);
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
      ready ? Promise.resolve() : this.sessionSnapshotStore.read(cacheKey).then(adoptSnapshot)
    )
      .catch(() => undefined)
      .finally(() => {
        hydration.titlePending = false;
        if (requests.initialSnapshotHydration === hydration) {
          delete requests.initialSnapshotHydration;
        }
      });
  }
}
