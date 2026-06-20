import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonSessionStoreAdapter } from "./json-store-adapter.js";
import {
  listSessionStoreRecordEntries,
  type SessionStoreAdapter,
  type SessionStoreEntryBatch,
  type SessionStoreListOptions,
  type SessionStoreRecord,
} from "./storage-adapter.js";
import {
  checksumSessionStoreRecord,
  migrateSessionStoreAdapter,
  migrateSessionStoreAdapterInBatches,
  planSessionStoreAdapterMigration,
  SessionStoreAdapterMigrationError,
  type SessionStoreAdapterMigrationCheckpoint,
} from "./store-migration.js";
import type { SessionEntry } from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createMemoryAdapter(initial: SessionStoreRecord = {}): SessionStoreAdapter & {
  entryWrites: Array<Array<[string, SessionEntry]>>;
  saves: SessionStoreRecord[];
  store: SessionStoreRecord;
} {
  const adapter: SessionStoreAdapter & {
    entryWrites: Array<Array<[string, SessionEntry]>>;
    saves: SessionStoreRecord[];
    store: SessionStoreRecord;
  } = {
    kind: "memory",
    store: structuredClone(initial) as SessionStoreRecord,
    entryWrites: [],
    saves: [] as SessionStoreRecord[],
    async loadStore(): Promise<SessionStoreRecord> {
      return structuredClone(adapter.store) as SessionStoreRecord;
    },
    async readEntry(_storePath: string, sessionKey: string): Promise<SessionEntry | undefined> {
      return structuredClone(adapter.store[sessionKey]);
    },
    async listEntries(_storePath: string, options?: SessionStoreListOptions) {
      return listSessionStoreRecordEntries(adapter.store, options);
    },
    async saveStore(_storePath: string, store: SessionStoreRecord) {
      const next = structuredClone(store) as SessionStoreRecord;
      adapter.saves.push(next);
      adapter.store = next;
    },
    async writeEntries(_storePath: string, entries: SessionStoreEntryBatch) {
      const batch = entries.map(([sessionKey, entry]) => [
        sessionKey,
        structuredClone(entry),
      ]) satisfies Array<[string, SessionEntry]>;
      adapter.entryWrites.push(batch);
      for (const [sessionKey, entry] of batch) {
        adapter.store[sessionKey] = entry;
      }
    },
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      const store = structuredClone(adapter.store) as SessionStoreRecord;
      const result = await mutator(store);
      await adapter.saveStore(_storePath, store);
      return result;
    },
  };
  return adapter;
}

describe("session store adapter migration", () => {
  it("imports a JSON session store into another adapter with verification", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-migration-"));
    tempRoots.push(dir);
    const sourceStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      sourceStorePath,
      `${JSON.stringify({ main: { sessionId: "sess-main", updatedAt: 1 } }, null, 2)}\n`,
      "utf-8",
    );
    const destination = createMemoryAdapter();

    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: jsonSessionStoreAdapter,
        destinationAdapter: destination,
        sourceStorePath,
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
      }),
    ).resolves.toMatchObject({ applied: true, verified: true });
    expect(destination.store).toEqual({ main: { sessionId: "sess-main", updatedAt: 1 } });
  });

  it("plans a dry run with deterministic checksums and conflicts", async () => {
    const source = createMemoryAdapter({
      b: { sessionId: "sess-b", updatedAt: 2 },
      a: { sessionId: "sess-a", updatedAt: 1 },
    });
    const destination = createMemoryAdapter({ b: { sessionId: "old-b", updatedAt: 0 } });

    const plan = await planSessionStoreAdapterMigration({
      sourceAdapter: source,
      destinationAdapter: destination,
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
    });

    expect(plan).toMatchObject({
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      sourceEntryCount: 2,
      destinationEntryCountBefore: 1,
      keys: ["a", "b"],
      conflictingKeys: ["b"],
    });
    expect(plan.sourceChecksum).toBe(checksumSessionStoreRecord(source.store));

    const dryRun = await migrateSessionStoreAdapter({
      sourceAdapter: source,
      destinationAdapter: destination,
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      mode: "dry-run",
    });
    expect(dryRun.applied).toBe(false);
    expect(destination.saves).toHaveLength(0);
  });

  it("applies and verifies a migration through the destination adapter", async () => {
    const source = createMemoryAdapter({ main: { sessionId: "sess-main", updatedAt: 1 } });
    const destination = createMemoryAdapter({ old: { sessionId: "old", updatedAt: 0 } });

    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: source,
        destinationAdapter: destination,
        sourceStorePath: "/json/sessions.json",
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
      }),
    ).resolves.toMatchObject({ applied: true, verified: true, rolledBack: false });
    expect(destination.store).toEqual(source.store);
    expect(destination.saves).toEqual([source.store]);
  });

  it("rolls back when post-write verification fails", async () => {
    const source = createMemoryAdapter({ main: { sessionId: "sess-main", updatedAt: 1 } });
    const destination = createMemoryAdapter({ old: { sessionId: "old", updatedAt: 0 } });
    const originalSaveStore = destination.saveStore.bind(destination);
    let saveCount = 0;
    destination.saveStore = async (storePath, store, options) => {
      saveCount += 1;
      if (saveCount === 1) {
        await originalSaveStore(
          storePath,
          { corrupt: { sessionId: "bad", updatedAt: 0 } },
          options,
        );
        return;
      }
      await originalSaveStore(storePath, store, options);
    };

    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: source,
        destinationAdapter: destination,
        sourceStorePath: "/json/sessions.json",
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
      }),
    ).rejects.toMatchObject({ name: "SessionStoreAdapterMigrationError", rolledBack: true });
    expect(destination.store).toEqual({ old: { sessionId: "old", updatedAt: 0 } });
    expect(destination.saves).toHaveLength(2);
    expect(destination.saves[0]).toEqual({ corrupt: { sessionId: "bad", updatedAt: 0 } });
    expect(destination.saves[1]).toEqual({ old: { sessionId: "old", updatedAt: 0 } });
  });

  it("refuses same-path migrations unless explicitly allowed", async () => {
    const source = createMemoryAdapter();
    const destination = createMemoryAdapter();
    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: source,
        destinationAdapter: destination,
        sourceStorePath: "/same/sessions.json",
        destinationStorePath: "/same/sessions.json",
        mode: "apply",
      }),
    ).rejects.toThrow("Refusing to migrate a session store onto itself");
  });

  it("exposes migration failure metadata", async () => {
    const source = createMemoryAdapter({ main: { sessionId: "sess-main", updatedAt: 1 } });
    const destination = createMemoryAdapter();
    destination.saveStore = async () => {
      throw new Error("write denied");
    };

    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: source,
        destinationAdapter: destination,
        sourceStorePath: "/json/sessions.json",
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
      }),
    ).rejects.toBeInstanceOf(SessionStoreAdapterMigrationError);
  });

  it("applies chunked migrations with resumable checkpoints", async () => {
    const source = createMemoryAdapter({
      a: { sessionId: "sess-a", updatedAt: 1 },
      b: { sessionId: "sess-b", updatedAt: 2 },
      c: { sessionId: "sess-c", updatedAt: 3 },
      d: { sessionId: "sess-d", updatedAt: 4 },
      e: { sessionId: "sess-e", updatedAt: 5 },
    });
    const destination = createMemoryAdapter();
    const checkpoints: SessionStoreAdapterMigrationCheckpoint[] = [];

    const result = await migrateSessionStoreAdapterInBatches({
      sourceAdapter: source,
      destinationAdapter: destination,
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      mode: "apply",
      batchSize: 2,
      onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
      },
    });

    expect(result).toMatchObject({
      applied: true,
      verified: true,
      batchSize: 2,
      batchesApplied: 3,
      entriesWritten: 5,
      malformedEntries: [],
    });
    expect(result.checkpoint).toMatchObject({
      nextOffset: 5,
      completed: true,
      appliedKeys: ["a", "b", "c", "d", "e"],
    });
    expect(checkpoints.map((checkpoint) => checkpoint.nextOffset)).toEqual([2, 4, 5]);
    expect(destination.entryWrites.map((batch) => batch.map(([sessionKey]) => sessionKey))).toEqual(
      [["a", "b"], ["c", "d"], ["e"]],
    );
    expect(destination.store).toEqual(source.store);
  });

  it("resumes chunked migrations from a matching checkpoint", async () => {
    const source = createMemoryAdapter({
      a: { sessionId: "sess-a", updatedAt: 1 },
      b: { sessionId: "sess-b", updatedAt: 2 },
      c: { sessionId: "sess-c", updatedAt: 3 },
    });
    const destination = createMemoryAdapter({ a: { sessionId: "sess-a", updatedAt: 1 } });
    const dryRun = await migrateSessionStoreAdapterInBatches({
      sourceAdapter: source,
      destinationAdapter: createMemoryAdapter(),
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      mode: "dry-run",
      batchSize: 1,
    });

    const result = await migrateSessionStoreAdapterInBatches({
      sourceAdapter: source,
      destinationAdapter: destination,
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      mode: "apply",
      batchSize: 1,
      checkpoint: {
        ...dryRun.checkpoint,
        nextOffset: 1,
        batchesApplied: 1,
        entriesWritten: 1,
        appliedKeys: ["a"],
      },
    });

    expect(result).toMatchObject({
      applied: true,
      batchesApplied: 3,
      entriesWritten: 3,
    });
    expect(destination.entryWrites.map((batch) => batch.map(([sessionKey]) => sessionKey))).toEqual(
      [["b"], ["c"]],
    );
  });

  it("reports malformed entries and rolls back partial chunked writes by default", async () => {
    const source = createMemoryAdapter({
      a: { sessionId: "sess-a", updatedAt: 1 },
      b: { sessionId: "", updatedAt: 2 },
      c: { sessionId: "sess-c", updatedAt: 3 },
    });
    const destination = createMemoryAdapter();

    const dryRun = await migrateSessionStoreAdapterInBatches({
      sourceAdapter: source,
      destinationAdapter: destination,
      sourceStorePath: "/json/sessions.json",
      destinationStorePath: "postgres://logical/type0",
      mode: "dry-run",
      batchSize: 2,
    });
    expect(dryRun.malformedEntries).toEqual([
      { sessionKey: "b", reason: "entry.sessionId must be a non-empty string" },
    ]);

    await expect(
      migrateSessionStoreAdapterInBatches({
        sourceAdapter: source,
        destinationAdapter: destination,
        sourceStorePath: "/json/sessions.json",
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
        batchSize: 1,
      }),
    ).rejects.toMatchObject({ name: "SessionStoreAdapterMigrationError", rolledBack: true });
    expect(destination.store).toEqual({});
    expect(destination.saves).toEqual([{}]);
  });

  it("refuses chunked migration into non-empty destinations without explicit opt-in", async () => {
    await expect(
      migrateSessionStoreAdapterInBatches({
        sourceAdapter: createMemoryAdapter({ a: { sessionId: "sess-a", updatedAt: 1 } }),
        destinationAdapter: createMemoryAdapter({ old: { sessionId: "old", updatedAt: 0 } }),
        sourceStorePath: "/json/sessions.json",
        destinationStorePath: "postgres://logical/type0",
        mode: "apply",
        batchSize: 1,
      }),
    ).rejects.toThrow("non-empty destination");
  });
});
