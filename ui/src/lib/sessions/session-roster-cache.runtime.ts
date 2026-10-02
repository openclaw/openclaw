import {
  openSessionRosterDatabase,
  resetSessionRosterDatabase,
  rosterRequestResult,
  rosterTransactionDone,
} from "./session-roster-cache-database.ts";
import {
  invalidateSessionRosterCache,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_STORE_NAME,
  sessionRosterGeneration,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

const pending = new Map<string, SessionRosterRecord>();
const latestPublications = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let writeChain = Promise.resolve();

type PendingRosterWrite = { record: SessionRosterRecord; generation: number };
const currentWrite = ({ record, generation }: PendingRosterWrite) =>
  generation === sessionRosterGeneration(record.scope);

async function writeRecords(records: PendingRosterWrite[]): Promise<void> {
  if (!records.some(currentWrite)) {
    return;
  }
  const { boundSessionRosterRecord, parseSessionRosterRecord } =
    await import("./session-roster-cache.reader.ts");
  if (!records.some(currentWrite)) {
    return;
  }
  const database = await openSessionRosterDatabase();
  if (!database) {
    return;
  }
  try {
    if (!records.some(currentWrite)) {
      return;
    }
    const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
    const completed = rosterTransactionDone(transaction);
    const store = transaction.objectStore(SESSION_ROSTER_STORE_NAME);
    const values: unknown[] = await rosterRequestResult(store.getAll());
    const next = new Map<string, SessionRosterRecord>();
    for (const value of values) {
      const record = parseSessionRosterRecord(value);
      if (!record) {
        store.clear();
        next.clear();
        break;
      }
      next.set(record.scope, record);
    }
    for (const write of records) {
      if (!currentWrite(write)) {
        continue;
      }
      const value = write.record;
      const record = boundSessionRosterRecord(value);
      if (record) {
        store.put(record);
        next.set(record.scope, record);
      } else {
        store.delete(value.scope);
        next.delete(value.scope);
      }
    }
    const retained = [...next.values()].toSorted((left, right) => right.savedAt - left.savedAt);
    for (const [index, record] of retained.entries()) {
      if (index >= 6 || Date.now() - record.savedAt > SESSION_ROSTER_MAX_AGE_MS) {
        store.delete(record.scope);
      }
    }
    await completed;
  } catch {
    database.close();
    await resetSessionRosterDatabase();
  } finally {
    database.close();
  }
}

export function persistSessionRoster(record: SessionRosterRecord, publication: number): void {
  if (!globalThis.indexedDB || publication <= (latestPublications.get(record.scope) ?? 0)) {
    return;
  }
  latestPublications.set(record.scope, publication);
  pending.set(record.scope, record);
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => void flushSessionRosters(), 500);
}

export async function flushSessionRosters(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const records = [...pending.values()].map((record) => ({
    record,
    generation: sessionRosterGeneration(record.scope),
  }));
  pending.clear();
  if (records.length > 0) {
    writeChain = writeChain.then(() => writeRecords(records));
  }
  await writeChain;
}

/** Retire one exact roster key; omitted scope is an explicit full-cache reset. */
export async function clearCachedBootState(scope?: string): Promise<void> {
  invalidateSessionRosterCache(scope);
  if (scope !== undefined) {
    pending.delete(scope);
    latestPublications.delete(scope);
  } else {
    pending.clear();
    latestPublications.clear();
  }
  // A scoped retirement must not strand another owner’s scheduled publication.
  if (pending.size === 0 && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  // A successor write must wait for deletion as well as the retired writer's lazy load.
  const precedingWrites = writeChain;
  writeChain = (async () => {
    try {
      await precedingWrites;
    } finally {
      if (scope === undefined) {
        await resetSessionRosterDatabase();
      } else {
        const database = await openSessionRosterDatabase();
        if (database) {
          try {
            const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
            const completed = rosterTransactionDone(transaction);
            const store = transaction.objectStore(SESSION_ROSTER_STORE_NAME);
            store.delete(scope);
            await completed;
          } finally {
            database.close();
          }
        }
      }
    }
  })();
  await writeChain;
}

if (
  globalThis.indexedDB &&
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("pagehide", () => void flushSessionRosters());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushSessionRosters();
    }
  });
}
