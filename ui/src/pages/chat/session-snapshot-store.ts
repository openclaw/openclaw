import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  isChatTranscriptMetadata,
  isProgressCard,
} from "../../lib/protocol-validators.generated/transcript.js";
import { listen } from "../../lib/reactive/listener.ts";
import * as json from "../../lib/snapshot-json.ts";
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
  peekPrewarmedChatSnapshot,
} from "./session-snapshot-prewarm.ts";
const CHAT_SNAPSHOT_PROJECTION_VERSION = 3;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;
const CHAT_SNAPSHOT_IDLE_TIMEOUT_MS = 1000;
const parsedPrewarms = new WeakMap<object, Promise<ChatSessionSnapshot | null>>();

const nonnegative = json.refine(json.number, (value) => value >= 0);
const sessionKeySchema = json.refine(json.text, (value) => value.length > 0);
const completePaginationSchema = json.object(
  {
    completeSnapshot: json.optional(json.literal(true)),
    hasMore: json.literal(false),
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const morePaginationSchema = json.object(
  {
    hasMore: json.literal(true),
    nextOffset: nonnegative,
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const paginationSchema = {
  parse(value: unknown) {
    return asOptionalRecord(value)?.hasMore === true
      ? morePaginationSchema.parse(value)
      : completePaginationSchema.parse(value);
  },
};
const snapshotSchema = json.object(
  {
    composer: json.optional(
      json.nullable(json.object({ id: json.text, provider: json.text, name: json.text })),
    ),
    board: json.optional(
      json.nullable(json.object({ snapshot: json.unknown, receivedAtMs: nonnegative }, true)),
    ),
    widgetHeights: json.optional(
      json.refine(
        json.record(json.refine(json.number, (height) => height >= 48 && height <= 8000)),
        (heights) => Object.keys(heights).length <= 100,
      ),
    ),
    transcriptMetadata: json.optional(json.checked(isChatTranscriptMetadata)),
    progressCard: json.optional(json.nullable(json.checked(isProgressCard))),
    deltaCursor: json.optional(json.text),
    // Only persisted warm metadata needs its full validator; read admission loads it below.
    historyState: json.optional(json.unknown),
    displayedLeafEntryId: json.optional(json.nullable(json.text)),
    // Message contents are opaque; only the array boundary needs validation.
    messages: json.checked<unknown[]>(Array.isArray),
    pagination: paginationSchema,
    sessionId: json.nullable(json.text),
  },
  true,
);
const recordSchema = json.refine(
  json.object(
    {
      projectionVersion: json.refine(
        json.number,
        (value) => Number.isSafeInteger(value) && value > 0,
      ),
      savedAt: nonnegative,
      sessionId: json.nullable(json.text),
      sessionKey: sessionKeySchema,
      snapshot: snapshotSchema,
    },
    true,
  ),
  (record) => record.sessionId === record.snapshot.sessionId,
);

type SessionSnapshotRecord = Omit<json.SnapshotValue<typeof recordSchema>, "snapshot"> & {
  snapshot: ChatSessionSnapshot;
};
const metadataFields = {
  savedAt: nonnegative,
  sessionKey: sessionKeySchema,
};
const metadataSchema = json.object({ ...metadataFields, weight: nonnegative }, true);
type SessionSnapshotMetadata = json.SnapshotValue<typeof metadataSchema>;
type PreparedSnapshotRecord = {
  record: SessionSnapshotRecord;
  metadata: SessionSnapshotMetadata;
};
type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
};
type SnapshotReadScope = {
  isCurrent: () => boolean;
  dispose: () => void;
};

const activeStores = new Set<SessionSnapshotStore>();

async function parseSnapshotRecord(
  value: unknown,
  sessionKey?: string,
  onBoard?: (board: ChatSessionSnapshot["board"]) => void,
): Promise<SessionSnapshotRecord | null> {
  const parsed = json.parseSnapshot(recordSchema, value);
  if (!parsed || (sessionKey && parsed.sessionKey !== sessionKey)) {
    return null;
  }
  const historyState = parsed.snapshot.historyState;
  if (historyState !== undefined) {
    // Do not hold board restoration behind the lazy transcript validator.
    onBoard?.(parsed.snapshot.board);
    const { isChatHistoryState } =
      await import("../../lib/protocol-validators.generated/history-state.js");
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
  onBoard?: (board: ChatSessionSnapshot["board"]) => void,
): Promise<ChatSessionSnapshot | null> {
  if (
    value === undefined ||
    !isCurrent() ||
    !isPersistableChatSnapshotKey(sessionKey) ||
    asOptionalRecord(value)?.projectionVersion !== CHAT_SNAPSHOT_PROJECTION_VERSION
  ) {
    return null;
  }
  const record = await parseSnapshotRecord(value, sessionKey, onBoard);
  if (!isCurrent()) {
    return null;
  }
  if (!record) {
    debugSnapshotStore("resetting cache after record shape mismatch");
    await resetSessionSnapshotDatabase();
  }
  return record?.snapshot ?? null;
}

function readSharedPrewarm(
  entry: object,
  read: () => Promise<ChatSessionSnapshot | null>,
): Promise<ChatSessionSnapshot | null> {
  let snapshot = parsedPrewarms.get(entry);
  if (!snapshot) {
    snapshot = read();
    parsedPrewarms.set(entry, snapshot);
  }
  return snapshot;
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
  );
  return snapshot && !entry.cancelled && peekPrewarmedChatSnapshot() === entry ? snapshot : null;
}

function createSnapshotRecord(
  sessionKey: string,
  pending: PendingSessionState,
): PreparedSnapshotRecord | null {
  let snapshot: ChatSessionSnapshot;
  let weight: number;
  try {
    let projected = pending.snapshot;
    const messages = projected.messages;
    let start = Math.max(0, messages.length - CHAT_SNAPSHOT_MESSAGE_LIMIT);
    // A history entry can project multiple rows; retain its whole sequence group.
    while (start > 0) {
      const seq = readSessionMessageSequence(messages[start]);
      if (seq === null || seq !== readSessionMessageSequence(messages[start - 1])) {
        break;
      }
      start--;
    }
    if (start > 0) {
      // Display rows are not Gateway page boundaries. Refill from zero on the
      // first upward scroll; the history owner deduplicates the overlap and
      // returns the next authoritative offset, including merged CLI histories.
      projected = {
        ...projected,
        messages: messages.slice(start),
        pagination: {
          hasMore: true,
          nextOffset: 0,
          ...(projected.pagination.totalMessages !== undefined
            ? { totalMessages: projected.pagination.totalMessages }
            : {}),
        },
      };
    }
    // Pairing credentials stay in the live projection, never the browser's disk cache.
    let redacted = false;
    const serialized = JSON.stringify(projected, (_key, value: unknown) => {
      if (value === projected.messages) {
        return projected.messages.map((message) => {
          const record = asOptionalRecord(message);
          if (!record || !Object.hasOwn(record, "openclawResponsesInputReplay")) {
            return message;
          }
          const { openclawResponsesInputReplay: _replay, ...display } = record;
          return display;
        });
      }
      const sanitized = removePairingQrContent(value);
      redacted ||= sanitized !== value;
      return sanitized;
    });
    snapshot = JSON.parse(serialized);
    // A receipt cannot certify metadata changed by the disk privacy projection.
    if (redacted) {
      delete snapshot.historyState;
    }
    weight = serialized.length;
  } catch {
    return null;
  }
  const envelope = {
    projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
  };
  return {
    record: { ...envelope, snapshot },
    metadata: {
      savedAt: pending.savedAt,
      sessionKey,
      weight: weight + JSON.stringify(envelope).length,
    },
  };
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
  // Reads and queued writes retain invalidation identity only until they settle.
  private readonly readScopes = new Map<string, { readers: number }>();
  // Cross-tab writes may leave this index stale until reload; the 30s prefetch
  // cooldown bounds the resulting redundant fetches without per-row IDB reads.
  private readonly savedAtBySession = new Map<string, number>();
  private savedAtSeed: Promise<void> | null = null;
  private cancelScheduledWrite: (() => void) | null = null;
  private writeChain = Promise.resolve();

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
        projectionVersion: 1,
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

  async read(
    sessionKey: string,
    onBoard?: (board: ChatSessionSnapshot["board"]) => void,
  ): Promise<ChatSessionSnapshot | null> {
    const scope = this.captureReadScope(sessionKey);
    try {
      const prewarm = consumePrewarmedChatSnapshot(sessionKey);
      const read = () =>
        (prewarm?.promise ?? readStoredChatSnapshotRecord(sessionKey)).then((value) =>
          readSnapshotRecord(sessionKey, value, scope.isCurrent, onBoard),
        );
      const snapshot = await (prewarm ? readSharedPrewarm(prewarm, read) : read());
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

  write(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    // The message cache remains the live UI owner; only durable admission is denied.
    if (!isPersistableChatSnapshotKey(sessionKey)) {
      return;
    }
    discardPrewarmedChatSnapshot(sessionKey);
    this.readScopes.delete(sessionKey);
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
    this.readScopes.delete(sessionKey);
    this.pending.delete(sessionKey);
    this.hydratedSnapshots.delete(sessionKey);
    this.savedAtBySession.delete(sessionKey);
    this.memoryCache?.delete(sessionKey);
  }

  async flush(): Promise<void> {
    this.cancelScheduledWrite?.();
    this.cancelScheduledWrite = null;
    const pending = [...this.pending.entries()];
    const pendingScopes = new Map(
      pending.map(([sessionKey]) => [sessionKey, this.captureReadScope(sessionKey)]),
    );
    this.pending.clear();
    try {
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
        const currentRecords = records.filter(({ record: { sessionKey } }) =>
          pendingScopes.get(sessionKey)!.isCurrent(),
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
    } finally {
      for (const scope of pendingScopes.values()) {
        scope.dispose();
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
    for (const [sessionKey, pending] of this.pending) {
      this.savedAtBySession.set(sessionKey, pending.savedAt);
    }
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
  await Promise.all([...activeStores].map((store) => store.whenIdle()));
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
