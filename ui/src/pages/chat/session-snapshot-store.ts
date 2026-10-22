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
  isPersistableChatSnapshotKey,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  debugSnapshotStore,
  openSessionSnapshotDatabase,
  readStoredChatSnapshotRecord,
  resetSessionSnapshotDatabase,
  SIDEBAR_SNAPSHOT_STORE_NAME,
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
} from "./session-snapshot-prewarm.ts";
const CHAT_SNAPSHOT_PROJECTION_VERSION = 3;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;
const CHAT_SNAPSHOT_IDLE_TIMEOUT_MS = 1000;

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
const sidebarRecordsSchema = json.array(
  json.object(
    {
      ...metadataFields,
      projectionVersion: json.literal(1),
      model: json.unknown,
    },
    true,
  ),
);
type SidebarRecord = json.SnapshotValue<typeof sidebarRecordsSchema>[number];
const sidebarRecordBytes = (record: SidebarRecord) =>
  new TextEncoder().encode(JSON.stringify(record)).byteLength;
type PreparedSnapshotRecord = {
  record: SessionSnapshotRecord;
  metadata: SessionSnapshotMetadata;
};
type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
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

async function accessSidebarSnapshot<Model>(
  key: string,
  validate: (value: unknown) => Model | null,
  isCurrent: () => boolean,
  incoming?: SidebarRecord,
): Promise<Model | null> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return null;
  }
  try {
    if (!isCurrent()) {
      return null;
    }
    const transaction = database.transaction(SIDEBAR_SNAPSHOT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME);
    const records = sidebarRecordsSchema.parse(await requestResult(store.getAll()));
    if (!isCurrent()) {
      await transactionComplete(transaction);
      return null;
    }
    const retained = records.filter((record) => record.sessionKey !== incoming?.sessionKey);
    if (incoming) {
      retained.push(incoming);
      store.put(incoming);
    }
    let bytes = 0;
    let result: Model | null = null;
    for (const [index, record] of retained.toSorted((a, b) => b.savedAt - a.savedAt).entries()) {
      const admitted = validate(record.model);
      if (admitted === null) {
        throw new Error("sidebar projection shape mismatch");
      }
      bytes += sidebarRecordBytes(record);
      if (
        index >= 8 ||
        bytes > 512 * 1024 ||
        Date.now() - record.savedAt > 30 * 24 * 60 * 60 * 1000
      ) {
        store.delete(record.sessionKey);
      } else if (record.sessionKey === key) {
        result = admitted;
      }
    }
    await transactionComplete(transaction);
    return isCurrent() ? result : null;
  } catch (error) {
    debugSnapshotStore("resetting cache after sidebar projection failure", error);
    if (isCurrent()) {
      await resetSessionSnapshotDatabase(database);
    }
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

  captureReadScope(sessionKey: string): () => boolean {
    const generation = snapshotStoreGeneration;
    const revision = this.revisions.get(sessionKey) ?? 0;
    this.revisions.set(sessionKey, revision);
    return () =>
      generation === snapshotStoreGeneration && revision === (this.revisions.get(sessionKey) ?? 0);
  }

  async readSidebar<Model>(
    key: string,
    validate: (value: unknown) => Model | null,
  ): Promise<Model | null> {
    if (!this.connected) {
      return null;
    }
    const isCurrent = this.captureReadScope(key);
    await this.writeChain;
    return accessSidebarSnapshot(key, validate, () => this.connected && isCurrent());
  }

  async writeSidebar<Model>(
    key: string,
    model: Model,
    validate: (value: unknown) => Model | null,
  ): Promise<boolean> {
    if (!this.connected || !key.startsWith("scope:[") || !key.includes("\u0000sidebar:")) {
      return false;
    }
    const isCurrent = this.captureReadScope(key);
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
            () => this.connected && isCurrent(),
            record,
          )) !== null;
      });
      await this.writeChain;
      return written;
    } catch (error) {
      debugSnapshotStore("sidebar projection could not be cached", error);
      return false;
    }
  }

  forgetSidebar(invalidation: SnapshotInvalidation): void {
    for (const key of this.revisions.keys()) {
      if (key.includes("\u0000sidebar:") && sidebarSnapshotInvalidationMatches(key, invalidation)) {
        this.forget(key);
      }
    }
  }

  async read(
    sessionKey: string,
    onBoard?: (board: ChatSessionSnapshot["board"]) => void,
  ): Promise<ChatSessionSnapshot | null> {
    const isCurrent = this.captureReadScope(sessionKey);
    const prewarm = consumePrewarmedChatSnapshot(sessionKey);
    const value = await (prewarm?.promise ?? readStoredChatSnapshotRecord(sessionKey));
    if (value === undefined || !isCurrent() || !isPersistableChatSnapshotKey(sessionKey)) {
      return null;
    }
    // Older display projections cannot resume a cursor or contribute a retained history prefix.
    if (asOptionalRecord(value)?.projectionVersion !== CHAT_SNAPSHOT_PROJECTION_VERSION) {
      return null;
    }
    const record = await parseSnapshotRecord(value, sessionKey, onBoard);
    if (!isCurrent()) {
      return null;
    }
    if (!record) {
      debugSnapshotStore("resetting cache after record shape mismatch");
      await resetSessionSnapshotDatabase();
      return null;
    }
    const snapshot = record.snapshot;
    setSessionCacheValue(this.hydratedSnapshots, sessionKey, new WeakRef(snapshot));
    return snapshot;
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
