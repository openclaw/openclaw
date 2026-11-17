import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as stateReader from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as mentionStore from "./mention-inbox-store.js";
import type { MentionStoreSource } from "./mention-inbox-store.js";
import { writeMentionStoreChanges } from "./mention-inbox-store.worker.js";
import { readMentionSnapshot } from "./mention-inbox-worker.js";
import { mentionReadOperations } from "./mention-inbox.worker.js";

describe("Mention Inbox worker snapshots", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databases: DatabaseSync[] = [];
  const read = mentionReadOperations["mentions.snapshot"];

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function createStore() {
    const filename = path.join(tempDirs.make("mention-snapshot-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(filename);
    databases.push(writer);
    writer.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      )`);
    admitSqliteSchema(writer);
    const reader = openNodeSqliteDatabase(filename);
    databases.push(reader);
    admitSqliteSchema(reader);
    return { writer, reader };
  }

  const first: MentionStoreSource = {
    key: "a".repeat(64),
    sequence: 0,
    expiresAt: 123,
    recipients: [],
  };
  const second: MentionStoreSource = { ...first, key: "b".repeat(64), sequence: 1 };

  function addSource(writer: DatabaseSync, source: MentionStoreSource, afterWrite = () => {}) {
    withSqlitePostCommitPublications(writer, () =>
      runSqliteImmediateTransactionSync(writer, () => {
        writeMentionStoreChanges(
          writer,
          { revision: source.sequence, nextSequence: source.sequence + 1 },
          new Map([[source.key, source]]),
        );
        afterWrite();
      }),
    );
  }

  function snapshot(sources: MentionStoreSource[]) {
    return { head: { revision: sources.length, nextSequence: sources.length }, sources };
  }

  it("uses only published heads to skip async snapshot reads without filesystem discovery", async () => {
    await withOpenClawTestState({ label: "mention-receipt" }, async () => {
      const context = captureOpenClawStateWorkerContext();
      const reads = vi.spyOn(stateReader, "executeExistingOpenClawStateRead");
      const discoveries: string[] = [];
      const readHead = mentionStore.getMentionStoreHeadAdmission;
      let checkingHead = false;
      vi.spyOn(mentionStore, "getMentionStoreHeadAdmission").mockImplementation((databasePath) => {
        checkingHead = true;
        try {
          return readHead(databasePath);
        } finally {
          checkingHead = false;
        }
      });
      const stat = fs.statSync;
      const realpath = fs.realpathSync.native;
      const record = (method: string) => {
        if (checkingHead) {
          discoveries.push(method);
        }
      };
      vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
        record("statSync");
        return Reflect.apply(stat, fs, args);
      });
      vi.spyOn(fs.realpathSync, "native").mockImplementation(
        (...args: Parameters<typeof fs.realpathSync.native>) => {
          record("realpathSync.native");
          return Reflect.apply(realpath, fs.realpathSync, args);
        },
      );
      syncBuiltinESMExports();
      // An absent receipt must reach the real asynchronous reader without creating a database.
      expect(await readMentionSnapshot(context, 0)).toBeUndefined();
      expect(reads).toHaveBeenCalledOnce();
      expect(fs.existsSync(context.admission.databasePath)).toBe(false);

      openOpenClawStateDatabase();
      runOpenClawStateWriteTransaction(({ db }) =>
        writeMentionStoreChanges(
          db,
          { revision: 0, nextSequence: 1 },
          new Map([[first.key, first]]),
        ),
      );
      const current = captureOpenClawStateWorkerContext();
      reads.mockClear();
      expect(await readMentionSnapshot(current, 1)).toBeUndefined();
      expect(reads).not.toHaveBeenCalled();

      runOpenClawStateWriteTransaction(({ db }) =>
        writeMentionStoreChanges(
          db,
          { revision: 1, nextSequence: 2 },
          new Map([[second.key, second]]),
        ),
      );
      expect(await readMentionSnapshot(current, 1)).toEqual(snapshot([first, second]));
      expect(reads).toHaveBeenCalledOnce();
      expect(discoveries).toEqual([]);
    });
  });

  it("returns only changed committed snapshots and preserves rolled-back sources", () => {
    const { writer, reader } = createStore();
    expect(read(-1, reader).snapshot).toEqual(snapshot([]));
    expect(read(0, reader)).toEqual({ type: "mentions.snapshot", snapshot: undefined });

    addSource(writer, first);
    expect(read(0, reader).snapshot).toEqual(snapshot([first]));
    expect(() =>
      addSource(writer, second, () => {
        throw new Error("rollback mention");
      }),
    ).toThrow("rollback mention");
    expect(read(1, reader).snapshot).toBeUndefined();
    expect(read(-1, reader).snapshot).toEqual(snapshot([first]));
  });

  it("keeps an atomic header and source snapshot when its owner commits during result delivery", () => {
    const { writer, reader } = createStore();
    addSource(writer, first);
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
              addSource(writer, second);
            }
            return method === "iterate" ? rows.values() : rows;
          },
        }),
      );
    }
    expect(read(-1, reader).snapshot).toEqual(snapshot([first]));
    expect(committed).toBe(true);
    expect(read(1, reader).snapshot).toEqual(snapshot([first, second]));
  });
});
