import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  getSessionCacheValue,
  MAX_CACHED_CHAT_SESSIONS,
  setSessionCacheValue,
} from "./session-cache.ts";
import {
  MAX_CACHED_CHAT_WEIGHT,
  type ChatCacheObserver,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
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
  subscribeSnapshotInvalidation,
  type SessionSnapshotInvalidationReason,
} from "./session-snapshot-invalidation-events.ts";
import { deleteStoredChatSnapshot } from "./session-snapshot-invalidation.ts";
import {
  consumePrewarmedChatSnapshot,
  discardPrewarmedChatSnapshot,
} from "./session-snapshot-prewarm.ts";
const CHAT_SNAPSHOT_PROJECTION_VERSION = 1;
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;
const CHAT_SNAPSHOT_IDLE_TIMEOUT_MS = 1000;

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
    // Message contents are opaque; only the array boundary needs validation.
    messages: z.custom<unknown[]>(Array.isArray),
    pagination: paginationSchema,
    sessionId: z.string().nullable(),
  })
  .strict();

const recordSchema = z
  .object({
    projectionVersion: z.number().int().positive(),
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
type PreparedSnapshotRecord = {
  record: SessionSnapshotRecord;
  metadata: SessionSnapshotMetadata;
};
type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
};

const activeStores = new Set<SessionSnapshotStore>();

function sanitizeSnapshot(
  snapshot: ChatSessionSnapshot,
): { snapshot: unknown; weight: number } | null {
  try {
    const json = JSON.stringify(snapshot);
    return json ? { snapshot: JSON.parse(json), weight: json.length } : null;
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
): PreparedSnapshotRecord | null {
  const sanitized = sanitizeSnapshot(pending.snapshot);
  if (!sanitized) {
    return null;
  }
  const envelope = {
    projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
  };
  const record = parseSnapshotRecord({ ...envelope, snapshot: sanitized.snapshot });
  // Validation does not transform JSON values. Preserve the existing code-unit
  // budget: snapshot JSON plus envelope JSON, excluding the enclosing snapshot key.
  return record
    ? {
        record,
        metadata: {
          savedAt: record.savedAt,
          sessionKey,
          weight: sanitized.weight + JSON.stringify(envelope).length,
        },
      }
    : null;
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

async function writeSnapshotRecords(
  records: PreparedSnapshotRecord[],
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
    if (generation !== snapshotStoreGeneration) {
      return [];
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
      const metadata = metadataSchema.safeParse(value);
      if (!metadata.success) {
        transaction.abort();
        throw new Error("IndexedDB metadata shape mismatch");
      }
      next.set(metadata.data.sessionKey, metadata.data);
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
  private readonly pending = new Map<string, PendingSessionState>();
  // Hydration identity suppresses unchanged writes; the bounded message cache
  // owns transcript retention, so eviction must leave no second strong owner.
  private readonly hydratedSnapshots = new Map<string, WeakRef<ChatSessionSnapshot>>();
  private readonly revisions = new Map<string, number>();
  // Cross-tab writes may leave this index stale until reload; the 30s prefetch
  // cooldown bounds the resulting redundant fetches without per-row IDB reads.
  private readonly savedAtBySession = new Map<string, number>();
  private savedAtSeed: Promise<void> | null = null;
  private savedAtSeedRetirements: Set<string> | null = null;
  private cancelScheduledWrite: (() => void) | null = null;
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
    this.revisions.set(sessionKey, revision);
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
    if (!isPersistableChatSnapshotKey(sessionKey)) {
      return null;
    }
    // Older display projections cannot resume a cursor or contribute a retained history prefix.
    if (asOptionalRecord(value)?.projectionVersion !== CHAT_SNAPSHOT_PROJECTION_VERSION) {
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
    // The message cache remains the live UI owner; only durable admission is denied.
    if (!isPersistableChatSnapshotKey(sessionKey)) {
      return;
    }
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
    this.cancelScheduledWrite?.();
    this.cancelScheduledWrite = null;
    const pending = [...this.pending.entries()];
    const pendingRevisions = new Map(
      pending.map(([sessionKey]) => [sessionKey, this.revisions.get(sessionKey) ?? 0]),
    );
    this.pending.clear();
    const records: PreparedSnapshotRecord[] = [];
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
        ({ record: { sessionKey } }) =>
          pendingRevisions.get(sessionKey) === (this.revisions.get(sessionKey) ?? 0),
      );
      const evicted = await writeSnapshotRecords(currentRecords, generation);
      if (evicted === null) {
        this.resetSavedAtIndex();
        return;
      }
      for (const sessionKey of evicted) {
        if (!this.pending.has(sessionKey)) {
          this.savedAtBySession.delete(sessionKey);
        }
      }
    });
    await this.writeChain;
  }

  forgetScope(prefix: string): void {
    this.savedAtSeedRetirements?.add(prefix);
    for (const key of new Set([
      ...this.revisions.keys(),
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
    this.cancelScheduledWrite?.();
    this.cancelScheduledWrite = null;
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
    const retiredScopes = new Set<string>();
    this.savedAtSeedRetirements = retiredScopes;
    const generation = snapshotStoreGeneration;
    const revisions = new Map(this.revisions);
    try {
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
          [...retiredScopes].some((prefix) => record.sessionKey.startsWith(prefix)) ||
          (revisions.get(record.sessionKey) ?? 0) !== (this.revisions.get(record.sessionKey) ?? 0)
        ) {
          continue;
        }
        const current = this.savedAtBySession.get(record.sessionKey) ?? 0;
        this.savedAtBySession.set(record.sessionKey, Math.max(current, record.savedAt));
      }
    } finally {
      this.savedAtSeedRetirements = null;
    }
  }

  private resetSavedAtIndex(): void {
    this.savedAtBySession.clear();
    for (const [sessionKey, pending] of this.pending) {
      this.savedAtBySession.set(sessionKey, pending.savedAt);
    }
  }
}

subscribeSnapshotInvalidation(async ({ sessionKey, scopePrefix }) => {
  for (const store of activeStores) {
    if (scopePrefix) {
      store.forgetScope(scopePrefix);
    } else if (sessionKey) {
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
