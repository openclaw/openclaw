import path from "node:path";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { MentionStoreSource } from "./mention-inbox-store.js";
import { writeMentionStoreChanges } from "./mention-inbox-store.worker.js";
import { mentionReadOperations } from "./mention-inbox.worker.js";

describe("Mention Inbox worker snapshots", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databases: DatabaseSync[] = [];
  const read = mentionReadOperations["mentions.snapshot"];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function open(location: string) {
    const database = openNodeSqliteDatabase(location);
    databases.push(database);
    return database;
  }

  function createStore() {
    const filename = path.join(tempDirs.make("mention-snapshot-"), "state.sqlite");
    const writer = open(filename);
    writer.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      )`);
    admitSqliteSchema(writer);
    const reader = open(filename);
    admitSqliteSchema(reader);
    return { writer, reader };
  }

  function write<T>(database: DatabaseSync, operation: () => T): T {
    return withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, operation),
    );
  }

  const first: MentionStoreSource = {
    key: "a".repeat(64),
    sequence: 0,
    expiresAt: 123,
    recipients: [],
  };
  const second: MentionStoreSource = { ...first, key: "b".repeat(64), sequence: 1 };

  it("reads one initial snapshot, reuses its head, and refreshes only committed own writes", () => {
    const { writer, reader } = createStore();
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const exec = vi.spyOn(reader, "exec");
    try {
      expect(read(-1, reader).snapshot).toEqual({
        head: { revision: 0, nextSequence: 0 },
        sources: [],
      });
      expect(reads.queries.filter((sql) => /from "config_machine_state"/iu.test(sql))).toHaveLength(
        1,
      );
      reads.queries.length = 0;
      expect(read(0, reader)).toEqual({ type: "mentions.snapshot", snapshot: undefined });
      expect(reads.queries).toEqual([]);
      expect(exec).not.toHaveBeenCalled();

      write(writer, () =>
        writeMentionStoreChanges(
          writer,
          { revision: 0, nextSequence: 1 },
          new Map([[first.key, first]]),
        ),
      );
      expect(read(0, reader).snapshot).toEqual({
        head: { revision: 1, nextSequence: 1 },
        sources: [first],
      });
      expect(() =>
        write(writer, () => {
          writeMentionStoreChanges(
            writer,
            { revision: 1, nextSequence: 2 },
            new Map([[second.key, second]]),
          );
          throw new Error("rollback mention");
        }),
      ).toThrow("rollback mention");
      reads.queries.length = 0;
      expect(read(1, reader).snapshot).toBeUndefined();
      // Rollback retires the carrier's staged coverage; one read repairs the committed head.
      expect(reads.queries).toHaveLength(1);
      reads.queries.length = 0;
      expect(read(1, reader).snapshot).toBeUndefined();
      expect(reads.queries).toEqual([]);
      expect(read(-1, reader).snapshot).toEqual({
        head: { revision: 1, nextSequence: 1 },
        sources: [first],
      });
    } finally {
      reads.restore();
    }
  });

  it("keeps an atomic header and source snapshot when its owner commits during result delivery", () => {
    const { writer, reader } = createStore();
    write(writer, () =>
      writeMentionStoreChanges(
        writer,
        { revision: 0, nextSequence: 1 },
        new Map([[first.key, first]]),
      ),
    );
    let committed = false;
    for (const method of ["all", "iterate"] as const) {
      const original = StatementSync.prototype[method];
      vi.spyOn(StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, args) {
            const result = Reflect.apply(target, receiver, args);
            // Finish the native read before committing during delivery on either query path.
            const rows = method === "iterate" ? [...result] : result;
            if (!committed && receiver.sourceSQL.includes('from "config_machine_state"')) {
              committed = true;
              write(writer, () =>
                writeMentionStoreChanges(
                  writer,
                  { revision: 1, nextSequence: 2 },
                  new Map([[second.key, second]]),
                ),
              );
            }
            return method === "iterate" ? rows.values() : rows;
          },
        }),
      );
    }
    expect(read(-1, reader).snapshot).toEqual({
      head: { revision: 1, nextSequence: 1 },
      sources: [first],
    });
    expect(committed).toBe(true);
    expect(read(1, reader).snapshot).toEqual({
      head: { revision: 2, nextSequence: 2 },
      sources: [first, second],
    });
  });
});
