import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { MAX_CHAT_THUMBNAILS, MAX_CHAT_THUMBNAIL_BYTES } from "../../lib/chat/row-display-facts.ts";
import { listen } from "../../lib/reactive/listener.ts";
import * as json from "../../lib/snapshot-json.ts";
import {
  getSessionCacheValue,
  MAX_CACHED_CHAT_SESSIONS,
  setSessionCacheValue,
} from "./session-cache.ts";
import {
  MAX_CACHED_CHAT_SNAPSHOT_WEIGHT,
  MAX_CACHED_CHAT_WEIGHT,
  type ChatCacheObserver,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { boundChatThumbnails, chatThumbnailWeight } from "./session-message-display-facts.ts";
import {
  accessSidebarSnapshot,
  sidebarRecordBytes,
  type SidebarRecord,
} from "./session-sidebar-snapshot.ts";
import {
  isPersistableChatSnapshotKey,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  debugSnapshotStore,
  openSessionSnapshotDatabase,
  readStoredChatSnapshotRecord,
  resetSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  snapshotStoreGeneration,
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
  type SessionSnapshotInvalidationReason,
  type SnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";
import { deleteStoredChatSnapshot } from "./session-snapshot-invalidation.ts";
import {
  consumePrewarmedChatSnapshot,
  discardPrewarmedChatSnapshot,
  loadChatHistoryStateValidator,
  peekPrewarmedChatSnapshot,
  prewarmedHistoryStateValidator,
  readSharedPrewarm,
} from "./session-snapshot-prewarm.ts";
import {
  CHAT_SNAPSHOT_PROJECTION_VERSION,
  createSnapshotRecord,
} from "./session-snapshot-projection.ts";
import {
  metadataSchema,
  recordSchema,
  type PreparedSnapshotRecord,
  type SessionSnapshotMetadata,
  type SessionSnapshotRecord,
} from "./session-snapshot-record.ts";
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;
const CHAT_SNAPSHOT_IDLE_TIMEOUT_MS = 1000;

type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
  weight: number;
};
type SnapshotReadScope = {
  isCurrent: () => boolean;
  dispose: () => void;
};

const activeStores = new Set<SessionSnapshotStore>();

async function parseSnapshotRecord(
  value: unknown,
  sessionKey?: string,
): Promise<SessionSnapshotRecord | null> {
  const parsed = json.parseSnapshot(recordSchema, value);
  if (!parsed || (sessionKey && parsed.sessionKey !== sessionKey)) {
    return null;
  }
  const historyState = parsed.snapshot.historyState;
  if (historyState !== undefined) {
    // A repeated dynamic import can yield past dispatch even after prewarm evaluated it.
    const isChatHistoryState =
      prewarmedHistoryStateValidator ?? (await loadChatHistoryStateValidator());
    if (!isChatHistoryState(historyState)) {
      return null;
    }
  }
  return { ...parsed, snapshot: { ...parsed.snapshot, historyState } };
}

async function readSnapshotRecord(
  sessionKey: string,
  value: unknown,
  isCurrent: () => boolean,
): Promise<ChatSessionSnapshot | null> {
  if (value === undefined || !isCurrent() || !isPersistableChatSnapshotKey(sessionKey)) {
    return null;
  }
  if (asOptionalRecord(value)?.projectionVersion !== CHAT_SNAPSHOT_PROJECTION_VERSION) {
    await deleteStoredChatSnapshot(sessionKey);
    return null;
  }
  const record = await parseSnapshotRecord(value, sessionKey);
  if (!isCurrent()) {
    return null;
  }
  if (!record) {
    debugSnapshotStore("resetting cache after record shape mismatch");
    await resetSessionSnapshotDatabase();
  }
  return record?.snapshot ?? null;
}

export async function readPrewarmedChatSnapshot(
  cacheKey: string,
): Promise<ChatSessionSnapshot | null> {
  const entry = peekPrewarmedChatSnapshot();
  if (entry?.cacheKey !== cacheKey) {
    return null;
  }
  const snapshot = await readSharedPrewarm(entry, () =>
    entry.promise.then((value) =>
      readSnapshotRecord(entry.cacheKey, value, () => !entry.cancelled),
    ),
  ).promise;
  return snapshot && !entry.cancelled && peekPrewarmedChatSnapshot() === entry ? snapshot : null;
}

async function readSnapshotMetadata(): Promise<SessionSnapshotMetadata[] | null> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return [];
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
    const values = await requestResult(
      transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).getAll(),
    );
    await transactionComplete(transaction);
    const records: SessionSnapshotMetadata[] = [];
    for (const value of values) {
      const record = json.parseSnapshot(metadataSchema, value);
      if (!record) {
        debugSnapshotStore("resetting cache after metadata shape mismatch");
        await resetSessionSnapshotDatabase(database);
        return null;
      }
      records.push(record);
    }
    return records;
  } catch (error) {
    debugSnapshotStore("IndexedDB read failed", error);
    await resetSessionSnapshotDatabase(database);
    return null;
  } finally {
    database.close();
  }
}

async function writeSnapshotRecords(
  records: PreparedSnapshotRecord[],
  generation: number,
): Promise<string[] | null> {
  if (records.length === 0 || generation !== snapshotStoreGeneration) {
    return null;
  }
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return null;
  }
  try {
    if (generation !== snapshotStoreGeneration) {
      return null;
    }
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readwrite",
    );
    const snapshotStore = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME);
    const metadataStore = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME);
    const currentValues = await requestResult(metadataStore.getAll());
    const next = new Map<string, SessionSnapshotMetadata>();
    for (const value of currentValues) {
      const metadata = json.parseSnapshot(metadataSchema, value);
      if (!metadata) {
        transaction.abort();
        throw new Error("IndexedDB metadata shape mismatch");
      }
      next.set(metadata.sessionKey, metadata);
    }
    for (const { record, metadata } of records) {
      next.set(record.sessionKey, metadata);
      snapshotStore.put(record);
      metadataStore.put(metadata);
    }
    const oldestFirst = [...next.values()].toSorted((left, right) => left.savedAt - right.savedAt);
    let totalWeight = oldestFirst.reduce((sum, metadata) => sum + metadata.weight, 0);
    const evicted: string[] = [];
    while (oldestFirst.length > MAX_CACHED_CHAT_SESSIONS || totalWeight > MAX_CACHED_CHAT_WEIGHT) {
      const oldest = oldestFirst.shift();
      if (!oldest) {
        break;
      }
      totalWeight -= oldest.weight;
      snapshotStore.delete(oldest.sessionKey);
      metadataStore.delete(oldest.sessionKey);
      evicted.push(oldest.sessionKey);
    }
    let thumbnailCount = oldestFirst.reduce((sum, item) => sum + item.thumbnailCount, 0);
    let thumbnailBytes = oldestFirst.reduce((sum, item) => sum + item.thumbnailBytes, 0);
    for (const metadata of oldestFirst) {
      if (thumbnailCount <= MAX_CHAT_THUMBNAILS && thumbnailBytes <= MAX_CHAT_THUMBNAIL_BYTES) {
        break;
      }
      if (!metadata.thumbnailCount) {
        continue;
      }
      const record = json.parseSnapshot(
        recordSchema,
        await requestResult(snapshotStore.get(metadata.sessionKey)),
      );
      if (!record) {
        transaction.abort();
        throw new Error("IndexedDB thumbnail record mismatch");
      }
      const snapshot = boundChatThumbnails(record.snapshot, {
        count: Math.max(0, MAX_CHAT_THUMBNAILS - (thumbnailCount - metadata.thumbnailCount)),
        bytes: Math.max(0, MAX_CHAT_THUMBNAIL_BYTES - (thumbnailBytes - metadata.thumbnailBytes)),
      });
      const retained = chatThumbnailWeight(snapshot);
      thumbnailCount += retained.count - metadata.thumbnailCount;
      thumbnailBytes += retained.bytes - metadata.thumbnailBytes;
      snapshotStore.put({ ...record, snapshot });
      metadataStore.put({
        ...metadata,
        thumbnailCount: retained.count,
        thumbnailBytes: retained.bytes,
      });
    }
    await transactionComplete(transaction);
    return evicted;
  } catch (error) {
    debugSnapshotStore("resetting cache after IndexedDB write failure", error);
    await resetSessionSnapshotDatabase(database);
    return null;
  } finally {
    database.close();
  }
}

export class SessionSnapshotStore implements ChatCacheObserver {
  private connected = false;
  private pending = new Map<string, PendingSessionState>();
  // Hydration identity suppresses unchanged writes; the bounded message cache
  // owns transcript retention, so eviction must leave no second strong owner.
  private readonly hydratedSnapshots = new Map<string, WeakRef<ChatSessionSnapshot>>();
  // Reads and queued writes retain invalidation identity only until they settle.
  private readonly readScopes = new Map<string, { readers: number }>();
  // Cross-tab writes may leave this index stale until reload; the 30s prefetch
  // cooldown bounds the resulting redundant fetches without per-row IDB reads.
  private readonly savedAtBySession = new Map<string, number>();
  private savedAtSeed: Promise<void> | null = null;
  private cancelScheduledWrite: (() => void) | null = null;
  private writeChain = Promise.resolve();
  private draining: Promise<void> | null = null;

  constructor(private readonly memoryCache?: ChatMessageCache) {}

  connect(): void {
    this.connected = true;
    activeStores.add(this);
  }

  disconnect(): void {
    this.connected = false;
    this.forgetSidebar({});
    void this.flush().finally(() => {
      if (!this.connected) {
        activeStores.delete(this);
      }
    });
  }

  /** Dispose after the final read or publication so idle keys have no retained metadata. */
  captureReadScope(sessionKey: string): SnapshotReadScope {
    const generation = snapshotStoreGeneration;
    const entry = this.readScopes.get(sessionKey) ?? { readers: 0 };
    this.readScopes.set(sessionKey, entry);
    entry.readers += 1;
    let disposed = false;
    return {
      isCurrent: () =>
        !disposed &&
        generation === snapshotStoreGeneration &&
        this.readScopes.get(sessionKey) === entry,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        entry.readers -= 1;
        if (entry.readers === 0 && this.readScopes.get(sessionKey) === entry) {
          this.readScopes.delete(sessionKey);
        }
      },
    };
  }

  async readSidebar<Model>(
    key: string,
    validate: (value: unknown) => Model | null,
  ): Promise<Model | null> {
    if (!this.connected) {
      return null;
    }
    const scope = this.captureReadScope(key);
    try {
      await this.writeChain;
      return await accessSidebarSnapshot(key, validate, () => this.connected && scope.isCurrent());
    } finally {
      scope.dispose();
    }
  }

  async writeSidebar<Model>(
    key: string,
    model: Model,
    validate: (value: unknown) => Model | null,
  ): Promise<boolean> {
    if (!this.connected || !key.startsWith("scope:[") || !key.includes("\u0000sidebar:")) {
      return false;
    }
    const scope = this.captureReadScope(key);
    try {
      const record: SidebarRecord = {
        sessionKey: key,
        savedAt: Date.now(),
        projectionVersion: 3,
        model: structuredClone(model),
      };
      if (sidebarRecordBytes(record) > 512 * 1024) {
        return false;
      }
      let written = false;
      this.writeChain = this.writeChain.then(async () => {
        written =
          (await accessSidebarSnapshot(
            key,
            validate,
            () => this.connected && scope.isCurrent(),
            record,
          )) !== null;
      });
      await this.writeChain;
      return written;
    } catch (error) {
      debugSnapshotStore("sidebar projection could not be cached", error);
      return false;
    } finally {
      scope.dispose();
    }
  }

  forgetSidebar(invalidation: SnapshotInvalidation): void {
    for (const key of this.readScopes.keys()) {
      if (key.includes("\u0000sidebar:") && sidebarSnapshotInvalidationMatches(key, invalidation)) {
        this.forget(key);
      }
    }
  }

  readReady(sessionKey: string): ChatSessionSnapshot | undefined {
    const entry = peekPrewarmedChatSnapshot();
    const snapshot = entry?.prepared?.snapshot;
    if (entry?.cacheKey !== sessionKey || entry.cancelled || !snapshot) {
      return undefined;
    }
    consumePrewarmedChatSnapshot(sessionKey);
    setSessionCacheValue(this.hydratedSnapshots, sessionKey, new WeakRef(snapshot));
    return snapshot;
  }

  async read(sessionKey: string): Promise<ChatSessionSnapshot | null> {
    const scope = this.captureReadScope(sessionKey);
    try {
      const prewarm = consumePrewarmedChatSnapshot(sessionKey);
      const read = () =>
        (prewarm?.promise ?? readStoredChatSnapshotRecord(sessionKey)).then((value) =>
          readSnapshotRecord(sessionKey, value, scope.isCurrent),
        );
      const prepared = prewarm ? readSharedPrewarm(prewarm, read) : undefined;
      const snapshot = await (prepared?.promise ?? read());
      if (!snapshot || !scope.isCurrent()) {
        return null;
      }
      setSessionCacheValue(this.hydratedSnapshots, sessionKey, new WeakRef(snapshot));
      return snapshot;
    } finally {
      scope.dispose();
    }
  }

  async loadSavedAtIndex(): Promise<void> {
    this.savedAtSeed ??= this.seedSavedAtIndex();
    await this.savedAtSeed;
  }

  readSavedAt(sessionKey: string): number | null {
    return this.pending.get(sessionKey)?.savedAt ?? this.savedAtBySession.get(sessionKey) ?? null;
  }

  write(sessionKey: string, snapshot: ChatSessionSnapshot, weight: number): void {
    // The message cache remains the live UI owner; only durable admission is denied.
    if (!isPersistableChatSnapshotKey(sessionKey) || weight > MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
      return;
    }
    discardPrewarmedChatSnapshot(sessionKey);
    this.readScopes.delete(sessionKey);
    if (getSessionCacheValue(this.hydratedSnapshots, sessionKey)?.deref() === snapshot) {
      return;
    }
    this.hydratedSnapshots.delete(sessionKey);
    // Cache reconciliation replaces snapshots immutably, so retaining this raw
    // reference until the bounded flush cannot observe in-place mutation.
    this.schedule(sessionKey, snapshot, weight);
  }

  async delete(sessionKey: string, reason?: SessionSnapshotInvalidationReason): Promise<void> {
    this.forget(sessionKey);
    await deleteStoredChatSnapshot(sessionKey, reason);
  }

  forget(sessionKey: string): void {
    discardPrewarmedChatSnapshot(sessionKey);
    this.readScopes.delete(sessionKey);
    this.pending.delete(sessionKey);
    this.hydratedSnapshots.delete(sessionKey);
    this.savedAtBySession.delete(sessionKey);
    this.memoryCache?.delete(sessionKey);
  }

  flush(): Promise<void> {
    this.cancelScheduledWrite?.();
    this.cancelScheduledWrite = null;
    if (!this.draining) {
      this.draining = (async () => {
        try {
          await this.drainPending();
        } finally {
          this.draining = null;
          if (this.pending.size > 0) {
            await this.flush();
          }
        }
      })();
    }
    return this.draining;
  }

  private async drainPending(): Promise<void> {
    // One drain owns projection and I/O; concurrent flushes retain only bounded
    // latest replacements, never another prepared batch behind a slow write.
    while (this.pending.size > 0) {
      const pending = this.pending;
      this.pending = new Map();
      const scopes = new Map(
        [...pending.keys()].map((sessionKey) => [sessionKey, this.captureReadScope(sessionKey)]),
      );
      try {
        const records: PreparedSnapshotRecord[] = [];
        let weight = 0;
        for (const [sessionKey, state] of pending) {
          pending.delete(sessionKey);
          const record = await createSnapshotRecord(sessionKey, state);
          if (!record) {
            // Rejection publishes invalidation, which awaits accepted DB writes.
            // Keep it outside writeChain so a connected store cannot await itself.
            await this.delete(sessionKey, "cache-eviction");
            continue;
          }
          records.push(record);
          weight += record.metadata.weight;
          while (weight > MAX_CACHED_CHAT_WEIGHT) {
            weight -= records.shift()!.metadata.weight;
          }
        }
        const generation = snapshotStoreGeneration;
        this.writeChain = this.writeChain.then(async () => {
          const currentRecords = records.filter(({ record: { sessionKey } }) =>
            scopes.get(sessionKey)!.isCurrent(),
          );
          const evicted = await writeSnapshotRecords(currentRecords, generation);
          if (evicted === null) {
            this.resetSavedAtIndex();
            return;
          }
          for (const { metadata } of currentRecords) {
            if (scopes.get(metadata.sessionKey)!.isCurrent()) {
              this.savedAtBySession.set(metadata.sessionKey, metadata.savedAt);
            }
          }
          for (const sessionKey of evicted) {
            this.savedAtBySession.delete(sessionKey);
          }
        });
        await this.writeChain;
      } finally {
        for (const scope of scopes.values()) {
          scope.dispose();
        }
      }
    }
  }

  forgetScope(prefix: string): void {
    for (const key of new Set([
      ...this.readScopes.keys(),
      ...this.pending.keys(),
      ...this.hydratedSnapshots.keys(),
      ...this.savedAtBySession.keys(),
      ...(this.memoryCache?.keys() ?? []),
    ])) {
      if (key.startsWith(prefix)) {
        this.forget(key);
      }
    }
  }

  clearMemory(): void {
    this.cancelScheduledWrite?.();
    this.cancelScheduledWrite = null;
    this.pending.clear();
    this.hydratedSnapshots.clear();
    this.readScopes.clear();
    this.savedAtBySession.clear();
    this.memoryCache?.clear();
  }

  async whenIdle(): Promise<void> {
    await this.draining;
    await this.whenWritesIdle();
  }

  // Invalidation can run during preparation, so it waits only for admitted writes.
  async whenWritesIdle(): Promise<void> {
    let accepted: Promise<void>;
    do {
      accepted = this.writeChain;
      await accepted;
    } while (accepted !== this.writeChain);
  }

  private schedule(sessionKey: string, snapshot: ChatSessionSnapshot, weight: number): void {
    const pending = {
      savedAt: Date.now(),
      snapshot,
      weight,
    };
    this.pending.delete(sessionKey);
    this.pending.set(sessionKey, pending);
    let totalWeight = [...this.pending.values()].reduce((sum, value) => sum + value.weight, 0);
    while (this.pending.size > MAX_CACHED_CHAT_SESSIONS || totalWeight > MAX_CACHED_CHAT_WEIGHT) {
      const oldestKey = this.pending.keys().next().value!;
      totalWeight -= this.pending.get(oldestKey)!.weight;
      this.pending.delete(oldestKey);
    }
    // The first pending write owns the deadline, including its idle timeout;
    // foreground traffic must not keep postponed snapshots alive indefinitely.
    if (this.cancelScheduledWrite) {
      return;
    }
    const timer = globalThis.setTimeout(() => {
      this.cancelScheduledWrite = null;
      if (typeof globalThis.requestIdleCallback === "function") {
        // Idle work stays cancellable so hide/disconnect flushes start immediately.
        const idle = globalThis.requestIdleCallback(() => void this.flush(), {
          timeout: CHAT_SNAPSHOT_IDLE_TIMEOUT_MS,
        });
        this.cancelScheduledWrite = () => globalThis.cancelIdleCallback(idle);
      } else {
        void this.flush();
      }
    }, CHAT_SNAPSHOT_WRITE_DELAY_MS);
    this.cancelScheduledWrite = () => globalThis.clearTimeout(timer);
  }

  private async seedSavedAtIndex(): Promise<void> {
    const records = await readSnapshotMetadata();
    if (!records) {
      this.resetSavedAtIndex();
      return;
    }
    // This index only avoids redundant prefetches; concurrent eviction may leave it stale.
    for (const record of records) {
      const current = this.savedAtBySession.get(record.sessionKey) ?? 0;
      this.savedAtBySession.set(record.sessionKey, Math.max(current, record.savedAt));
    }
  }

  private resetSavedAtIndex(): void {
    this.savedAtBySession.clear();
  }
}

subscribeSnapshotInvalidation(async (invalidation) => {
  const { sessionKey, scopePrefix } = invalidation;
  for (const store of activeStores) {
    store.forgetSidebar(invalidation);
    if (scopePrefix) {
      store.forgetScope(scopePrefix);
    } else if (sessionKey) {
      store.forget(sessionKey);
    } else {
      store.clearMemory();
    }
  }
  await Promise.all([...activeStores].map((store) => store.whenWritesIdle()));
});

function flushActiveStores(): void {
  for (const store of activeStores) {
    void store.flush();
  }
}

// Module-lifetime browser events flush every active store, including during page teardown.
if (typeof window !== "undefined") {
  listen(window, "pagehide", flushActiveStores);
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushActiveStores();
    }
  });
}
