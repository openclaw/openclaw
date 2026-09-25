import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as sqliteTransaction from "../../infra/sqlite-transaction.js";
import {
  revokeSqliteReclamationCommit,
  waitForSqliteReclamationParentRelease,
  withSqliteReclamationAuthorization,
} from "./session-accessor.sqlite-reclamation-commit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function waitForApproval(progress: Int32Array): void {
  const deadline = performance.now() + 5_000;
  while (Atomics.load(progress, 0) === 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error("worker did not consume commit approval");
    }
    Atomics.wait(progress, 0, 0, remaining);
  }
}

function createCommitFixture(
  options: {
    holdAfterApproval?: boolean;
    checkpointAfterCommit?: boolean;
    outcome?: "rollback" | "exit-before-commit" | "exit-after-commit";
  } = {},
) {
  const directory = fs.realpathSync(tempDirs.make("openclaw-reclamation-commit-"));
  const databasePath = path.join(directory, "proof.sqlite");
  const database = openNodeSqliteDatabase(databasePath);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES (1)",
  );
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const progress = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`;
  const worker = new Worker(
    new URL("./session-accessor.sqlite-reclamation-commit.test-support.ts", import.meta.url),
    {
      workerData: { databasePath, gate, progress: progress.buffer, ...options },
      execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
    },
  );
  const exited = once(worker, "exit");
  const requested = once(worker, "message");
  const release = () => {
    Atomics.store(progress, 1, 1);
    Atomics.notify(progress, 1);
  };
  return {
    database,
    databasePath,
    gate,
    progress,
    worker,
    exited,
    requested,
    release,
    value: () => database.prepare("SELECT value FROM proof").get()?.value,
    withAuthorization<T>(
      assertCurrent: () => void,
      run: (authorize: () => unknown[]) => Promise<T>,
    ) {
      return withSqliteReclamationAuthorization(gate, database, assertCurrent, run);
    },
    async close() {
      release();
      await exited;
      database.close();
    },
  };
}

test("does not wait for a parent acknowledgment without a consumed commit approval", () => {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  waitForSqliteReclamationParentRelease(gate);
  expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
  revokeSqliteReclamationCommit(gate);
  expect(() => waitForSqliteReclamationParentRelease(gate)).toThrow("commit was not authorized");
});

test.each([false, true])(
  "joins parent probe release before checkpoint (release fails: %s)",
  async (releaseFails) => {
    const fixture = createCommitFixture({ checkpointAfterCommit: true });
    const transact = sqliteTransaction.runSqliteImmediateTransactionSync;
    let heldWriter = false;
    let releaseProbe: (() => void) | undefined;
    let probeStillHeld: (() => boolean) | undefined;
    try {
      await fixture.requested;
      const checkpoint = once(fixture.worker, "message");
      if (releaseFails) {
        const open = nodeSqlite.openNodeSqliteDatabase;
        vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
          const probe = open(...args);
          const exec = probe.exec.bind(probe);
          const close = probe.close.bind(probe);
          probeStillHeld = () => probe.isOpen && probe.isTransaction;
          releaseProbe = () => {
            if (probe.isOpen) {
              if (probe.isTransaction) {
                exec("ROLLBACK");
              }
              close();
            }
          };
          vi.spyOn(probe, "exec").mockImplementation((sql) => {
            if (sql === "COMMIT" || sql === "ROLLBACK") {
              throw new Error(`injected probe ${sql} failure`);
            }
            return exec(sql);
          });
          vi.spyOn(probe, "close").mockImplementation(() => {
            throw new Error("injected probe close failure");
          });
          return probe;
        });
      }
      vi.spyOn(sqliteTransaction, "runSqliteImmediateTransactionSync").mockImplementation(
        (db, operation, options) =>
          transact(
            db,
            () => {
              const value = operation();
              heldWriter = db.isTransaction;
              const gate = new Int32Array(fixture.gate);
              const committing = Atomics.load(gate, 0);
              fixture.release();
              Atomics.wait(gate, 0, committing, 5_000);
              expect(Atomics.load(gate, 0)).not.toBe(committing);
              return value;
            },
            options,
          ),
      );
      await fixture.withAuthorization(
        () => {},
        async (authorize) => {
          const errors = authorize();
          if (releaseFails) {
            expect(errors.map(String)).toEqual(
              expect.arrayContaining([
                "Error: injected probe COMMIT failure",
                "Error: injected probe close failure",
                "Error: SQLite commit-settlement probe remains in a transaction after close",
              ]),
            );
            expect(probeStillHeld?.()).toBe(true);
          } else {
            expect(errors).toEqual([]);
          }
        },
      );
      const [observed] = await checkpoint;
      expect(heldWriter).toBe(true);
      expect(observed).toMatchObject(
        releaseFails
          ? {
              error: "Error: SQLite parent commit-settlement probe did not release its writer lock",
            }
          : { checkpointCompleted: true, health: { state: "complete", walBytes: 0 } },
      );
      expect(await fixture.exited).toEqual([0]);
      expect(Atomics.load(new Int32Array(fixture.gate), 0)).toBe(observed.parentRelease);
      expect(fixture.value()).toBe(2);
    } finally {
      releaseProbe?.();
      await fixture.close();
    }
  },
);

test.each(["transient", "permanent", "closed"] as const)(
  "joins a consumed commit despite a %s barrier failure",
  async (fault) => {
    const fixture = createCommitFixture({ holdAfterApproval: true });
    const actualTransaction = sqliteTransaction.runSqliteImmediateTransactionSync;
    let faultInjected = false;
    try {
      await fixture.requested;
      vi.spyOn(sqliteTransaction, "runSqliteImmediateTransactionSync").mockImplementation(
        (db, operation, options) => {
          if (!faultInjected || fault !== "transient") {
            waitForApproval(fixture.progress);
            faultInjected = true;
            if (fault !== "transient") {
              fixture.release();
            }
            if (fault === "closed" && db.isOpen) {
              db.close();
            }
            throw new Error("injected non-busy barrier failure");
          }
          fixture.release();
          return actualTransaction(db, operation, options);
        },
      );
      const recovered = await fixture.withAuthorization(
        () => {},
        async (authorize) => authorize(),
      );
      expect(recovered.length).toBeGreaterThan(0);
      expect(
        recovered.every((error) => String(error).includes("injected non-busy barrier failure")),
      ).toBe(true);
      expect(fixture.value()).toBe(2);
    } finally {
      await fixture.close();
    }
  },
);

test.each([
  { outcome: undefined, value: 2, exitCode: 0 },
  { outcome: "rollback" as const, value: 1, exitCode: 0 },
  { outcome: "exit-before-commit" as const, value: 1, exitCode: 7 },
  { outcome: "exit-after-commit" as const, value: 2, exitCode: 9 },
])(
  "joins Worker settlement before queued retirement ($outcome)",
  async ({ outcome, value, exitCode }) => {
    const fixture = createCommitFixture({ outcome });
    let retired = false;
    try {
      await fixture.requested;
      await fixture.withAuthorization(
        () => {
          queueMicrotask(() => {
            retired = true;
          });
        },
        async (authorize) => {
          authorize();
          expect(retired).toBe(false);
          expect(fixture.value()).toBe(value);
          expect(await fixture.exited).toEqual([exitCode]);
          expect(retired).toBe(true);
        },
      );
    } finally {
      await fixture.close();
    }
  },
);

test("rolls back when the live authority rejects the prepared deletion", async () => {
  const fixture = createCommitFixture();
  try {
    await fixture.requested;
    await fixture.withAuthorization(
      () => {
        throw new Error("retired owner");
      },
      async (authorize) => {
        expect(authorize).toThrow("retired owner");
      },
    );
    await fixture.exited;
    expect(fixture.value()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("cannot revive a commit checkpoint after its decision deadline", async () => {
  const fixture = createCommitFixture();
  try {
    await fixture.requested;
    await fixture.exited;
    await fixture.withAuthorization(
      () => {},
      async (authorize) => {
        expect(authorize).toThrow("checkpoint expired");
      },
    );
    expect(fixture.value()).toBe(1);
  } finally {
    await fixture.close();
  }
}, 10_000);

test.each([false, true])(
  "preserves the authoritative outcome when barrier close fails (rejected: %s)",
  async (rejected) => {
    const fixture = createCommitFixture();
    const actualOpen = nodeSqlite.openNodeSqliteDatabase;
    try {
      await fixture.requested;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
        const database = actualOpen(...args);
        const actualClose = database.close.bind(database);
        vi.spyOn(database, "close").mockImplementationOnce(() => {
          actualClose();
          throw new Error("injected close failure");
        });
        return database;
      });
      await fixture.withAuthorization(
        () => {
          if (rejected) {
            throw new Error("retired owner");
          }
        },
        async (authorize) => {
          if (rejected) {
            expect(authorize).toThrow("retired owner");
          } else {
            expect(authorize().map(String)).toEqual(["Error: injected close failure"]);
          }
        },
      );
      await fixture.exited;
      expect(fixture.value()).toBe(rejected ? 1 : 2);
    } finally {
      await fixture.close();
    }
  },
);
