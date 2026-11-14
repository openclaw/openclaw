import { readStoredChatSnapshotRecord } from "./session-snapshot-database.ts";
import {
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

type PreparedSnapshotRead = ReturnType<
  typeof import("./session-snapshot-store.ts").readPrewarmedChatSnapshot
>;

export type PrewarmedSnapshot = {
  cacheKey: string;
  cancelled: boolean;
  promise: Promise<unknown>;
  ready?: Promise<void>;
  prepared?: {
    promise: PreparedSnapshotRead;
    snapshot?: Awaited<PreparedSnapshotRead>;
  };
};

let pending: PrewarmedSnapshot | undefined;
export let prewarmedHistoryStateValidator:
  | typeof import("../../lib/protocol-validators.generated/history-state.js").isChatHistoryState
  | undefined;

export async function loadChatHistoryStateValidator() {
  const { isChatHistoryState } =
    await import("../../lib/protocol-validators.generated/history-state.js");
  prewarmedHistoryStateValidator = isChatHistoryState;
  return isChatHistoryState;
}

export function peekPrewarmedChatSnapshot(): PrewarmedSnapshot | undefined {
  return pending;
}

export function discardPrewarmedChatSnapshot(cacheKey?: string): void {
  if (pending && (cacheKey === undefined || pending.cacheKey === cacheKey)) {
    pending.cancelled = true;
    pending = undefined;
  }
}

export function prewarmChatSnapshot(cacheKey: string): Promise<void> {
  discardPrewarmedChatSnapshot();
  const generation = snapshotStoreGeneration;
  const entry: PrewarmedSnapshot = {
    cacheKey,
    cancelled: false,
    promise: readStoredChatSnapshotRecord(cacheKey)
      .then((record) =>
        entry.cancelled || generation !== snapshotStoreGeneration ? undefined : record,
      )
      .catch(() => undefined),
  };
  pending = entry;
  // Validate once before mount; dispatch reads facts without adopting display rows.
  entry.ready = (async () => {
    try {
      const [{ readPrewarmedChatSnapshot }] = await Promise.all([
        import("./session-snapshot-store.ts"),
        loadChatHistoryStateValidator(),
      ]);
      if (pending === entry) {
        await readPrewarmedChatSnapshot(cacheKey);
      }
    } catch {}
  })();
  return entry.ready;
}

export function consumePrewarmedChatSnapshot(cacheKey: string): PrewarmedSnapshot | undefined {
  if (pending?.cacheKey !== cacheKey) {
    return undefined;
  }
  const prewarm = pending;
  pending = undefined;
  return prewarm;
}

subscribeSnapshotInvalidation(({ sessionKey, scopePrefix }) => {
  if (!scopePrefix || pending?.cacheKey.startsWith(scopePrefix)) {
    discardPrewarmedChatSnapshot(sessionKey);
  }
});
