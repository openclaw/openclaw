import { z } from "zod";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  debugSnapshotStore,
  deleteSessionSnapshotEntries,
  openSessionSnapshotDatabase,
  resetSessionSnapshotDatabase,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "./session-snapshot-database.ts";
import {
  publishSnapshotInvalidation,
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";
import { sidebarSnapshotScopeKey, type SidebarSnapshotScope } from "./sidebar-snapshot-scope.ts";
export { sidebarSnapshotScopeKey, type SidebarSnapshotScope } from "./sidebar-snapshot-scope.ts";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 8;
const MAX_BYTES = 512 * 1024;
const recordSchema = z
  .object({
    key: z.string().startsWith("scope:["),
    projectionVersion: z.literal(1),
    savedAt: z.number().finite().nonnegative(),
    model: z.unknown(),
  })
  .strict();
type SnapshotRecord = z.infer<typeof recordSchema>;
type Operation = { key: string; cancelled: boolean };

function recordBytes(record: SnapshotRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

/** Display projections share transcript cache custody, never Gateway authority. */
export class SidebarSnapshotStore<Model> {
  private readonly operations = new Set<Operation>();
  private writeChain = Promise.resolve();
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly validate: (value: unknown) => Model | null) {
    this.unsubscribe = subscribeSnapshotInvalidation((invalidation) => {
      for (const operation of this.operations) {
        if (sidebarSnapshotInvalidationMatches(operation.key, invalidation)) {
          operation.cancelled = true;
        }
      }
      // Let already-issued transactions finish before the shared owner deletes their rows.
      return this.writeChain;
    });
  }

  async read(scope: SidebarSnapshotScope): Promise<Model | null> {
    const operation = this.begin(scope);
    if (!operation) {
      return null;
    }
    try {
      await this.writeChain;
      return await this.access(operation);
    } finally {
      this.operations.delete(operation);
    }
  }

  async write(scope: SidebarSnapshotScope, model: Model): Promise<void> {
    const operation = this.begin(scope);
    if (!operation) {
      return;
    }
    let record: SnapshotRecord;
    try {
      const admitted = this.validate(model);
      if (admitted === null) {
        return;
      }
      // Detach the settled display model from later live mutations before queueing it.
      record = recordSchema.parse(
        JSON.parse(
          JSON.stringify({
            key: operation.key,
            projectionVersion: 1,
            savedAt: Date.now(),
            model: admitted,
          }),
        ),
      );
      if (this.validate(record.model) === null || recordBytes(record) > MAX_BYTES) {
        return;
      }
      this.writeChain = this.writeChain.then(async () => {
        await this.access(operation, record);
      });
      await this.writeChain;
    } catch (error) {
      debugSnapshotStore("sidebar projection could not be cached", error);
    } finally {
      this.operations.delete(operation);
    }
  }

  async invalidate(scope: SidebarSnapshotScope): Promise<void> {
    const key = sidebarSnapshotScopeKey(scope);
    if (key) {
      await publishSnapshotInvalidation({ sessionKey: key });
      await deleteSessionSnapshotEntries(key, "key");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const operation of this.operations) {
      operation.cancelled = true;
    }
  }

  private begin(scope: SidebarSnapshotScope): Operation | null {
    const key = sidebarSnapshotScopeKey(scope);
    if (!key || this.disposed) {
      return null;
    }
    const operation = { key, cancelled: false };
    this.operations.add(operation);
    return operation;
  }

  private async access(operation: Operation, incoming?: SnapshotRecord): Promise<Model | null> {
    if (operation.cancelled) {
      return null;
    }
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      return null;
    }
    try {
      if (operation.cancelled) {
        return null;
      }
      const transaction = database.transaction(SIDEBAR_SNAPSHOT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME);
      const values: unknown[] = await requestResult(store.getAll());
      if (operation.cancelled) {
        await transactionComplete(transaction);
        return null;
      }
      const records = new Map<string, SnapshotRecord>();
      for (const value of values) {
        const parsed = recordSchema.safeParse(value);
        if (!parsed.success || this.validate(parsed.data.model) === null) {
          await transactionComplete(transaction);
          throw new Error("sidebar projection shape mismatch");
        }
        records.set(parsed.data.key, parsed.data);
      }
      if (incoming) {
        records.set(incoming.key, incoming);
        store.put(incoming);
      }
      const now = Date.now();
      const retained = [...records.values()]
        .toSorted((a, b) => a.savedAt - b.savedAt)
        .filter((record) => {
          if (now - record.savedAt <= MAX_AGE_MS) {
            return true;
          }
          store.delete(record.key);
          return false;
        });
      let bytes = retained.reduce((sum, record) => sum + recordBytes(record), 0);
      while (retained.length > MAX_RECORDS || bytes > MAX_BYTES) {
        const oldest = retained.shift();
        if (!oldest) {
          break;
        }
        bytes -= recordBytes(oldest);
        store.delete(oldest.key);
      }
      const record = retained.find((candidate) => candidate.key === operation.key);
      const result = record ? this.validate(record.model) : null;
      await transactionComplete(transaction);
      return operation.cancelled ? null : result;
    } catch (error) {
      debugSnapshotStore("resetting cache after sidebar projection failure", error);
      if (!operation.cancelled) {
        await resetSessionSnapshotDatabase(database);
      }
      return null;
    } finally {
      database.close();
    }
  }
}
