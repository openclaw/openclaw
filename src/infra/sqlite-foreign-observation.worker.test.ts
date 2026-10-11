import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  createSqliteForeignObservation,
  runSqliteForeignUse,
} from "./sqlite-foreign-observation.js";
import type {
  ObservationOperations,
  ObservationRow,
} from "./sqlite-foreign-observation.test-support.js";
import { publishSqliteCommittedState } from "./sqlite-post-commit.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
});

function openDatabase(location: string) {
  const database = openNodeSqliteDatabase(location);
  databases.push(database);
  return database;
}

describe("coherent worker refresh and commit receipts", () => {
  let worker: SqliteWorkerStore<ObservationOperations>;
  let pathname: string;
  let writer: DatabaseSync;
  let foreign: ChildProcess | undefined;
  let foreignExit: Promise<number> | undefined;
  let reply = createDeferredCore();
  const directories = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      try {
        if (foreign?.connected) {
          foreign.send("close");
        }
        if (foreignExit) {
          expect(await foreignExit).toBe(0);
        }
      } finally {
        await worker?.close();
        if (writer?.isOpen) {
          writer.close();
        }
        cleanup();
      }
    }),
  );
  beforeAll(async () => {
    pathname = path.join(directories.make("sqlite-foreign-worker-"), "facts.sqlite");
    writer = openNodeSqliteDatabase(pathname);
    writer.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE observation_facts (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO observation_facts VALUES ('guard', 1), ('own', 0);`);
    worker = await openSqliteWorkerStore<ObservationOperations>({
      moduleUrl: new URL("./sqlite-foreign-observation.test-support.ts", import.meta.url),
      databasePath: pathname,
      input: undefined,
    });
    foreignExit = runManagedCommand({
      bin: resolveTestNodeExecPath(),
      args: [
        "--input-type=commonjs",
        "-e",
        `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        process.on("message", (command) => {
          if (command === "close") {
            db.close();
            process.disconnect();
            return;
          }
          db.prepare("UPDATE observation_facts SET value = 0 WHERE key = 'guard'").run();
          process.send("committed");
        });
        process.on("disconnect", () => { if (db.isOpen) db.close(); });
        process.send("ready");
      `,
        pathname,
      ],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      onReady(child) {
        foreign = child;
        child.on("message", () => reply.resolve());
      },
    });
    void foreignExit.then(
      () => reply.reject(new Error("Foreign writer closed before its acknowledgement")),
      (error: unknown) => reply.reject(error),
    );
    await reply.promise;
  });

  async function foreignRevoke() {
    reply = createDeferredCore();
    foreign!.send("revoke");
    await reply.promise;
  }

  function workerFixture() {
    writer.exec("UPDATE observation_facts SET value = CASE key WHEN 'guard' THEN 1 ELSE 0 END");
    const database = openDatabase(pathname);
    const observation = createSqliteForeignObservation(database, () => {});
    const certification = observation.createCertification();
    const facts = new Map<string, number>();
    let reads = 0;
    let readStatements: string[] = [];
    const read = async () => {
      reads += 1;
      const snapshot = await worker.execute({ type: "read", input: undefined });
      readStatements = snapshot.statements;
      return snapshot.rows;
    };
    const install = (rows: ObservationRow[]) => {
      facts.clear();
      for (const row of rows) {
        facts.set(row.key, row.value);
      }
    };
    const refresh = async () => {
      const token = certification.beginRefresh();
      const rows = await read();
      if (!token.accept()) {
        return false;
      }
      install(rows);
      return true;
    };
    return {
      certification,
      facts,
      read,
      refresh,
      reads: () => reads,
      readStatements: () => readStatements,
    };
  }

  it("accepts a complete stable worker snapshot and rejects a foreign write before installation", async () => {
    const { certification, facts, read, refresh } = workerFixture();
    expect(await refresh()).toBe(true);
    expect([...facts]).toEqual([
      ["guard", 1],
      ["own", 0],
    ]);
    const token = certification.beginRefresh();
    expect(await read()).toEqual([
      { key: "guard", value: 1 },
      { key: "own", value: 0 },
    ]);
    await foreignRevoke();
    expect(token.accept()).toBe(false);
    expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(false);
    expect(await refresh()).toBe(true);
    expect(facts.get("guard")).toBe(0);
  });

  it("does not let a delayed refresh overwrite or retire a newer complete snapshot", async () => {
    const { certification, facts, read, refresh } = workerFixture();
    const delayed = certification.beginRefresh();
    const oldRows = await read();
    writer.exec("UPDATE observation_facts SET value = 0 WHERE key = 'guard'");
    expect(await refresh()).toBe(true);
    expect(oldRows[0]).toEqual({ key: "guard", value: 1 });
    expect(delayed.accept()).toBe(false);
    expect(facts.get("guard")).toBe(0);
    expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(true);
  });

  it.each([false, true])(
    "recertifies after an own-worker receipt without hiding an interleaved foreign revoke (%s)",
    async (withForeignRevoke) => {
      const { certification, facts, refresh, reads, readStatements } = workerFixture();
      expect(await refresh()).toBe(true);
      const receipt = await worker.execute({ type: "write", input: { key: "own", value: 2 } });
      if (withForeignRevoke) {
        await foreignRevoke();
      }
      let notifiedCurrent: boolean | undefined;
      publishSqliteCommittedState({
        installFacts() {
          for (const [key, fact] of receipt.facts) {
            if (fact.kind === "postimage") {
              facts.set(key, fact.value);
            }
          }
        },
        invalidate: () => certification.invalidate(),
        notify() {
          notifiedCurrent = runSqliteForeignUse((use) => certification.isCurrent(use));
        },
      });
      expect(facts.get("own")).toBe(2);
      expect(notifiedCurrent).toBe(false);
      expect(reads()).toBe(1);
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      const hostSql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        expect(await refresh()).toBe(true);
        expect(facts.get("guard")).toBe(withForeignRevoke ? 0 : 1);
        expect(reads()).toBe(2);
        expect(hostSql.queries).toHaveLength(2);
        expect(readStatements()).toEqual([
          "BEGIN",
          expect.stringContaining("observation_facts"),
          "COMMIT",
        ]);
        expect(requests.mock.calls.filter(([request]) => request.type === "execute")).toHaveLength(
          1,
        );
        hostSql.queries.length = 0;
        for (let use = 0; use < 3; use += 1) {
          expect(runSqliteForeignUse((frame) => certification.isCurrent(frame))).toBe(true);
        }
        expect(hostSql.queries).toHaveLength(3);
        expect(requests.mock.calls.filter(([request]) => request.type === "execute")).toHaveLength(
          1,
        );
        expect(reads()).toBe(2);
      } finally {
        hostSql.restore();
        requests.mockRestore();
      }
    },
  );
});
