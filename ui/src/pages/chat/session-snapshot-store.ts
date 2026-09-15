import { z } from "zod";
import {
  getSessionCacheValue,
  MAX_CACHED_CHAT_SESSIONS,
  setSessionCacheValue,
} from "./session-cache.ts";
import {
  MAX_CACHED_CHAT_WEIGHT,
  measureChatSnapshotWeight,
  type ChatCacheObserver,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
  readStoredChatSnapshotRecord,
  resetSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
  type SessionSnapshotInvalidationReason,
} from "./session-snapshot-invalidation-events.ts";
import { deleteStoredChatSnapshot } from "./session-snapshot-invalidation.ts";
import {
  consumePrewarmedChatSnapshot,
  discardPrewarmedChatSnapshot,
} from "./session-snapshot-prewarm.ts";
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;

const paginationSchema = z.discriminatedUnion("hasMore", [
  z
    .object({
      completeSnapshot: z.literal(true).optional(),
      hasMore: z.literal(false),
      totalMessages: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      hasMore: z.literal(true),
      nextOffset: z.number().finite().nonnegative(),
      totalMessages: z.number().finite().nonnegative().optional(),
    })
    .strict(),
]);

const snapshotSchema = z
  .object({
    deltaCursor: z.string().optional(),
    displayedLeafEntryId: z.string().nullable().optional(),
    messages: z.array(z.unknown()),
    pagination: paginationSchema,
    sessionId: z.string().nullable(),
  })
  .strict();

const recordSchema = z
  .object({
    savedAt: z.number().finite().nonnegative(),
    sessionId: z.string().nullable(),
    sessionKey: z.string().min(1),
    snapshot: snapshotSchema,
  })
  .strict()
  .refine((record) => record.sessionId === record.snapshot.sessionId);

type SessionSnapshotRecord = z.infer<typeof recordSchema>;
const metadataSchema = z
  .object({
    savedAt: z.number().finite().nonnegative(),
    sessionKey: z.string().min(1),
    weight: z.number().finite().nonnegative(),
  })
  .strict();
type SessionSnapshotMetadata = z.infer<typeof metadataSchema>;
type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
};

const activeStores = new Set<SessionSnapshotStore>();

function debugSnapshotStore(message: string, error?: unknown): void {
  if (error === undefined) {
    console.debug(`[chat-snapshot-cache] ${message}`);
  } else {
    console.debug(`[chat-snapshot-cache] ${message}`, error);
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB failed")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB aborted")),
    );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
  });
}

function sanitizeSnapshot(snapshot: ChatSessionSnapshot): unknown {
  try {
    const json = JSON.stringify(snapshot);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

function parseSnapshotRecord(value: unknown, sessionKey?: string): SessionSnapshotRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success && (!sessionKey || parsed.data.sessionKey === sessionKey)
    ? parsed.data
    : null;
}

function createSnapshotRecord(
  sessionKey: string,
  pending: PendingSessionState,
): SessionSnapshotRecord | null {
  const sanitizedSnapshot = sanitizeSnapshot(pending.snapshot);
  if (!sanitizedSnapshot) {
    return null;
  }
  const parsed = recordSchema.safeParse({
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
    snapshot: sanitizedSnapshot,
  });
  return parsed.success ? parsed.data : null;
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
    await transactionDone(transaction);
    const records: SessionSnapshotMetadata[] = [];
    for (const value of values) {
      const record = metadataSchema.safeParse(value);
      if (!record.success) {
        debugSnapshotStore("resetting cache after metadata shape mismatch");
        await resetSessionSnapshotDatabase(database);
        return null;
      }
      records.push(record.data);
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

function measureStoredRecordWeight(record: SessionSnapshotRecord): number {
  const snapshotWeight = measureChatSnapshotWeight(record.snapshot) ?? 0;
  try {
    return (
      snapshotWeight +
      JSON.stringify({
        savedAt: record.savedAt,
        sessionId: record.sessionId,
        sessionKey: record.sessionKey,
      }).length
    );
  } catch {
    return snapshotWeight;
  }
}

// Commit-tail fallback: if a global invalidation lands after our puts already
// committed, surgically retract only keys that still hold our exact stale
// write. Comparison and deletion happen in a single readwrite transaction, so
// an intervening same-key write cannot slip between them. Identity covers the
// full written record: savedAt alone collides, because it comes from Date.now()
// and independent writers can share a timestamp under coarse timer precision.
// A newer-generation replacement under the same key must therefore survive
// even when its savedAt equals ours.
function isSameSnapshotWrite(
  current: SessionSnapshotRecord,
  expected: SessionSnapshotRecord,
): boolean {
  try {
    // Both sides pass through the same zod schema, so key order is canonical
    // and a whole-record comparison covers savedAt, sessionId, and snapshot.
    return JSON.stringify(current) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function retractStaleSnapshotWrites(
  written: ReadonlyMap<string, SessionSnapshotRecord>,
): Promise<void> {
  if (written.size === 0) {
    return;
  }
  const database = await openSessionSnapshotDatabase().catch(() => null);
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readwrite",
    );
    const snapshotStore = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME);
    const metadataStore = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME);
    const completed = transactionDone(transaction);
    for (const [sessionKey, expected] of written) {
      let current: unknown;
      try {
        current = await requestResult(snapshotStore.get(sessionKey));
      } catch {
        continue;
      }
      if (current === undefined) {
        continue;
      }
      const record = parseSnapshotRecord(current, sessionKey);
      if (record && isSameSnapshotWrite(record, expected)) {
        snapshotStore.delete(sessionKey);
        metadataStore.delete(sessionKey);
      }
    }
    // Best-effort cleanup; a failed retract must not trigger a reset.
    await completed.catch(() => undefined);
  } catch {
    // Best-effort cleanup; never fail the suppressing flush.
  } finally {
    database.close();
  }
}

async function writeSnapshotRecords(
  records: SessionSnapshotRecord[],
  generation: number,
): Promise<string[] | null> {
  if (records.length === 0 || generation !== snapshotStoreGeneration) {
    return [];
  }
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return [];
  }
  try {
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readwrite",
    );
    const snapshotStore = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME);
    const metadataStore = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME);
    const currentValues = await requestResult(metadataStore.getAll());
    // Note: this guard covers global invalidation (the only path that bumps
    // snapshotStoreGeneration). Per-session deletes fence via the revision
    // filter at flush dispatch; a same-key per-session delete landing
    // mid-write across tabs is a separate tracked race, not covered here.
    if (generation !== snapshotStoreGeneration) {
      transaction.abort();
      try {
        await transactionDone(transaction);
      } catch {
        // Aborting is the intended outcome; suppression is not a write failure.
      }
      return [];
    }
    const next = new Map<string, SessionSnapshotMetadata>();
    for (const value of currentValues) {
      const metadata = metadataSchema.safeParse(value);
      if (!metadata.success) {
        transaction.abort();
        throw new Error("IndexedDB metadata shape mismatch");
      }
      next.set(metadata.data.sessionKey, metadata.data);
    }
    for (const record of records) {
      const metadata = {
        savedAt: record.savedAt,
        sessionKey: record.sessionKey,
        weight: measureStoredRecordWeight(record),
      } satisfies SessionSnapshotMetadata;
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
    // Commit-tail guard: an invalidation can land while awaiting commit, after
    // puts are already queued. Abort on generation change during the wait; if
    // the commit already won, retract only our exact stale keys (full write
    // identity, so newer-generation replacements under the same key survive).
    const written = new Map(records.map((record) => [record.sessionKey, record]));
    const unsubscribe = subscribeSnapshotInvalidation(() => {
      if (generation !== snapshotStoreGeneration) {
        try {
          transaction.abort();
        } catch {
          // Commit already settled; the post-commit check below handles it.
        }
      }
    });
    let commitError: Error | undefined;
    try {
      await transactionDone(transaction);
    } catch (error) {
      commitError = new Error("IndexedDB write failed", { cause: error });
    } finally {
      unsubscribe();
    }
    if (generation !== snapshotStoreGeneration) {
      if (commitError === undefined) {
        await retractStaleSnapshotWrites(written);
      }
      // Either aborted or retracted: suppression, not a write failure, so do
      // not enter the reset path below.
      return [];
    }
    if (commitError !== undefined) {
      throw commitError;
    }
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
  private readonly pending = new Map<string, PendingSessionState>();
  // Hydration identity suppresses unchanged writes; the bounded message cache
  // owns transcript retention, so eviction must leave no second strong owner.
  private readonly hydratedSnapshots = new Map<string, WeakRef<ChatSessionSnapshot>>();
  private readonly revisions = new Map<string, number>();
  // Cross-tab writes may leave this index stale until reload; the 30s prefetch
  // cooldown bounds the resulting redundant fetches without per-row IDB reads.
  private readonly savedAtBySession = new Map<string, number>();
  private savedAtSeed: Promise<void> | null = null;
  private writeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private writeChain = Promise.resolve();

  constructor(private readonly memoryCache?: ChatMessageCache) {}

  connect(): void {
    this.connected = true;
    activeStores.add(this);
  }

  disconnect(): void {
    this.connected = false;
    void this.flush().finally(() => {
      if (!this.connected) {
        activeStores.delete(this);
      }
    });
  }

  captureReadScope(sessionKey: string): () => boolean {
    const generation = snapshotStoreGeneration;
    const revision = this.revisions.get(sessionKey) ?? 0;
    return () =>
      generation === snapshotStoreGeneration && revision === (this.revisions.get(sessionKey) ?? 0);
  }

  async read(
    sessionKey: string,
    onPrewarm?: (readyAt: number | undefined) => void,
  ): Promise<ChatSessionSnapshot | null> {
    const isCurrent = this.captureReadScope(sessionKey);
    const prewarm = consumePrewarmedChatSnapshot(sessionKey);
    if (prewarm) {
      // The pane must know the read's origin before deciding whether startup can wait.
      onPrewarm?.(prewarm.readyAt);
    }
    const value = await (prewarm?.promise ?? readStoredChatSnapshotRecord(sessionKey));
    if (value === undefined || !isCurrent()) {
      return null;
    }
    const record = parseSnapshotRecord(value, sessionKey);
    if (!record) {
      debugSnapshotStore("resetting cache after record shape mismatch");
      await resetSessionSnapshotDatabase();
      return null;
    }
    setSessionCacheValue(this.hydratedSnapshots, sessionKey, new WeakRef(record.snapshot));
    return record.snapshot;
  }

  async loadSavedAtIndex(): Promise<void> {
    this.savedAtSeed ??= this.seedSavedAtIndex();
    await this.savedAtSeed;
  }

  readSavedAt(sessionKey: string): number | null {
    return this.pending.get(sessionKey)?.savedAt ?? this.savedAtBySession.get(sessionKey) ?? null;
  }

  write(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    discardPrewarmedChatSnapshot(sessionKey);
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    if (getSessionCacheValue(this.hydratedSnapshots, sessionKey)?.deref() === snapshot) {
      return;
    }
    this.hydratedSnapshots.delete(sessionKey);
    // Cache reconciliation replaces snapshots immutably, so retaining this raw
    // reference until the debounced flush cannot observe in-place mutation.
    this.schedule(sessionKey, snapshot);
  }

  async delete(sessionKey: string, reason?: SessionSnapshotInvalidationReason): Promise<void> {
    this.forget(sessionKey);
    await deleteStoredChatSnapshot(sessionKey, reason);
  }

  forget(sessionKey: string): void {
    discardPrewarmedChatSnapshot(sessionKey);
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    this.pending.delete(sessionKey);
    this.hydratedSnapshots.delete(sessionKey);
    this.savedAtBySession.delete(sessionKey);
    this.memoryCache?.delete(sessionKey);
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const pending = [...this.pending.entries()];
    const pendingRevisions = new Map(
      pending.map(([sessionKey]) => [sessionKey, this.revisions.get(sessionKey) ?? 0]),
    );
    this.pending.clear();
    const records: SessionSnapshotRecord[] = [];
    for (const [sessionKey, state] of pending) {
      const record = createSnapshotRecord(sessionKey, state);
      if (record) {
        records.push(record);
      } else {
        await this.delete(sessionKey, "cache-eviction");
      }
    }
    const generation = snapshotStoreGeneration;
    this.writeChain = this.writeChain.then(async () => {
      const currentRecords = records.filter(
        ({ sessionKey }) =>
          pendingRevisions.get(sessionKey) === (this.revisions.get(sessionKey) ?? 0),
      );
      const evicted = await writeSnapshotRecords(currentRecords, generation);
      if (evicted === null) {
        this.resetSavedAtIndex();
        return;
      }
      if (generation !== snapshotStoreGeneration) {
        // Stale flush was suppressed and never durably written. Drop its
        // savedAt hints (only entries still holding our stale timestamp, so a
        // newer-generation write under the same key survives).
        for (const record of currentRecords) {
          if (this.savedAtBySession.get(record.sessionKey) === record.savedAt) {
            this.savedAtBySession.delete(record.sessionKey);
          }
        }
      }
      for (const sessionKey of evicted) {
        if (!this.pending.has(sessionKey)) {
          this.savedAtBySession.delete(sessionKey);
        }
      }
    });
    await this.writeChain;
  }

  clearMemory(): void {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pending.clear();
    this.hydratedSnapshots.clear();
    this.revisions.clear();
    this.savedAtBySession.clear();
    this.memoryCache?.clear();
  }

  async whenIdle(): Promise<void> {
    await this.writeChain;
  }

  private schedule(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    const pending = {
      savedAt: Date.now(),
      snapshot,
    };
    this.pending.set(sessionKey, pending);
    this.savedAtBySession.set(sessionKey, pending.savedAt);
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
    }
    this.writeTimer = globalThis.setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, CHAT_SNAPSHOT_WRITE_DELAY_MS);
  }

  private async seedSavedAtIndex(): Promise<void> {
    const generation = snapshotStoreGeneration;
    const revisions = new Map(this.revisions);
    const records = await readSnapshotMetadata();
    if (generation !== snapshotStoreGeneration) {
      return;
    }
    if (!records) {
      this.resetSavedAtIndex();
      return;
    }
    for (const record of records) {
      if (
        (revisions.get(record.sessionKey) ?? 0) !== (this.revisions.get(record.sessionKey) ?? 0)
      ) {
        continue;
      }
      const current = this.savedAtBySession.get(record.sessionKey) ?? 0;
      this.savedAtBySession.set(record.sessionKey, Math.max(current, record.savedAt));
    }
  }

  private resetSavedAtIndex(): void {
    this.savedAtBySession.clear();
    for (const [sessionKey, pending] of this.pending) {
      this.savedAtBySession.set(sessionKey, pending.savedAt);
    }
  }
}

subscribeSnapshotInvalidation(async ({ sessionKey }) => {
  for (const store of activeStores) {
    if (sessionKey) {
      store.forget(sessionKey);
    } else {
      store.clearMemory();
    }
  }
  await Promise.all([...activeStores].map((store) => store.whenIdle()));
});

function flushActiveStores(): void {
  for (const store of activeStores) {
    void store.flush();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushActiveStores);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushActiveStores();
    }
  });
}
