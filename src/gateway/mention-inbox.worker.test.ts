import path from "node:path";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { writeMentionStoreChanges, type MentionStoreSource } from "./mention-inbox-store.js";
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

  function open(location = ":memory:") {
    const database = openNodeSqliteDatabase(location);
    databases.push(database);
    return database;
  }

  function createStore(database: DatabaseSync) {
    database.exec(`CREATE TABLE config_machine_state (
      state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
    )`);
    admitSqliteSchema(database);
  }

  it("checks an unchanged revision with one read and no transaction", () => {
    const database = open();
    createStore(database);
    expect(read(-1, database).snapshot).toEqual({
      head: { revision: 0, nextSequence: 0 },
      sources: [],
    });
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const exec = vi.spyOn(database, "exec");
    try {
      expect(read(0, database)).toEqual({ type: "mentions.snapshot", snapshot: undefined });
      expect(reads.queries).toHaveLength(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      reads.restore();
    }
  });

  it.each(["before transaction", "after snapshot head"] as const)(
    "keeps head and sources coherent when a peer commits %s",
    (commitAt) => {
      const filename = path.join(tempDirs.make("mention-snapshot-"), "state.sqlite");
      const writer = open(filename);
      writer.exec("PRAGMA journal_mode = WAL");
      createStore(writer);
      const first: MentionStoreSource = {
        key: "a".repeat(64),
        sequence: 0,
        expiresAt: 123,
        recipients: [],
      };
      const second: MentionStoreSource = { ...first, key: "b".repeat(64), sequence: 1 };
      writer.exec("BEGIN IMMEDIATE");
      writeMentionStoreChanges(
        writer,
        { revision: 0, nextSequence: 1 },
        new Map([[first.key, first]]),
      );
      writer.exec("COMMIT");
      const reader = open(filename);
      admitSqliteSchema(reader);
      let committed = false;
      const commitPeer = () => {
        committed = true;
        writer.exec("BEGIN IMMEDIATE");
        writeMentionStoreChanges(
          writer,
          { revision: 1, nextSequence: 2 },
          new Map([[second.key, second]]),
        );
        writer.exec("COMMIT");
      };
      if (commitAt === "before transaction") {
        const exec = reader.exec.bind(reader);
        vi.spyOn(reader, "exec").mockImplementation((sql) => {
          if (!committed && /^BEGIN\b/iu.test(sql)) {
            commitPeer();
          }
          return exec(sql);
        });
      } else {
        // oxlint-disable-next-line typescript/unbound-method -- The proxy keeps the native receiver.
        const get = StatementSync.prototype.get;
        vi.spyOn(StatementSync.prototype, "get").mockImplementation(
          new Proxy(get, {
            apply(target, receiver: StatementSync, args) {
              const result = Reflect.apply(target, receiver, args);
              if (
                !committed &&
                reader.isTransaction &&
                receiver.sourceSQL.includes('from "config_machine_state"')
              ) {
                commitPeer();
              }
              return result;
            },
          }),
        );
      }
      const snapshot = read(0, reader).snapshot;
      expect(committed).toBe(true);
      expect(snapshot).toEqual(
        commitAt === "before transaction"
          ? { head: { revision: 2, nextSequence: 2 }, sources: [first, second] }
          : { head: { revision: 1, nextSequence: 1 }, sources: [first] },
      );
    },
  );
});
