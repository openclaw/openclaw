import { listen } from "../../lib/reactive/listener.ts";
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
    let readySnapshot: ChatSessionSnapshot | null | undefined;
    let adoption: Promise<void> | undefined;
    const reading = this.sessionSnapshotStore.read(
      cacheKey,
      (board) => void restoreBoard(board),
      (snapshot) => (readySnapshot = snapshot),
    );
    const adoptSnapshot = (afterPaint: boolean) => {
      if (readySnapshot === undefined) {
        return Promise.resolve();
      }
      const storedSnapshot = readySnapshot;
      return (adoption ??= (async () => {
        if (storedSnapshot && afterPaint && !document.hidden) {
          // Visible adoption waits for paint; hiding must release pending history.
          await new Promise<void>((resolve) => {
            const release = () => {
              stopVisibility();
              resolve();
            };
            const stopVisibility = listen(document, "visibilitychange", release);
            requestAnimationFrame(() => window.setTimeout(release, 0));
          });
        }
        delete hydration.adoptReadySnapshot;
        delete hydration.readReadyHistory;
        if (!isCurrent()) {
          return;
        }
        const cached = mergeStoredChatSessionSnapshot(cache, state, target, storedSnapshot);
        if (requests.acceptedHistory || !cached) {
          return;
        }
        // A sibling may already own a newer base in the shared cache.
        applyChatCacheSnapshot(state, cached);
        cacheChatSessionSnapshot(cache, state, target, { ...cached, messages: state.chatMessages });
        this.syncSessionReactions();
        if (cached.progressCard !== undefined) {
          const progressTarget = this.resolveChatReadTarget();
          if (progressTarget) {
            this.progressCards.hydrate(progressTarget, cached.progressCard);
          }
        }
      })());
    };
    const hydration: InitialChatSnapshotHydration = {
      titlePending: true,
      sessionKey,
      connected: this.context.gateway.snapshot.phase === "connected",
      readReadyHistory: () =>
        isCurrent() && !requests.acceptedHistory && readySnapshot?.deltaCursor
          ? { deltaCursor: readySnapshot.deltaCursor, historyState: readySnapshot.historyState }
          : undefined,
      adoptReadySnapshot: () => adoptSnapshot(true),
      promise: reading
        .then(async (storedSnapshot) => {
          readySnapshot = storedSnapshot;
          const gateway = this.context.gateway.snapshot;
          if (
            gateway.client &&
            (gateway.phase === "connecting" || gateway.phase === "reconnecting")
          ) {
            await gateway.client.connectSent;
          }
          // Cached rows can paint before live route confirmation, which still gates commands.
          if (!isCurrent()) {
            return;
          }
          await adoptSnapshot(this.context.gateway.snapshot.phase === "connected");
          return restoreBoard(storedSnapshot?.board);
        })
        .catch(() => undefined)
        .finally(() => {
          hydration.titlePending = false;
          if (requests.initialSnapshotHydration === hydration) {
            delete requests.initialSnapshotHydration;
          }
        }),
    };
    // The title observes cache readiness; network history never waits on it.
    requests.initialSnapshotHydration = projectChatFields(hydration, ["titlePending"]);
  }
}
