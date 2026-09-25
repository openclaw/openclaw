import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import {
  revokeSqliteReclamationCommit,
  withSqliteReclamationAuthorization,
} from "./session-accessor.sqlite-reclamation-commit.js";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createCommitFixture(
  options: {
    holdAfterApproval?: boolean;
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
  const progress = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`;
  const worker = new Worker(
    new URL("./session-accessor.sqlite-reclamation-commit.test-support.ts", import.meta.url),
    {
      workerData: { databasePath, gate, progress: progress.buffer, ...options },
      execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
    },
  );
  const exited = once(worker, "exit");
  const accepted = createDeferredCore();
  const release = () => {
    Atomics.store(progress, 0, 1);
    Atomics.notify(progress, 0);
  };
  const databaseOptions = { agentId: "main", path: databasePath };
  return {
    database,
    gate,
    accepted: accepted.promise,
    exited,
    release,
    value: () => database.prepare("SELECT value FROM proof").get()?.value,
    nextWrite: (run: () => void) => runOpenClawAgentWriteAdmission(databaseOptions, run),
    run(assertCurrent: () => void = () => {}) {
      return withSqliteReclamationAuthorization(gate, database, assertCurrent, (authorize) =>
        runSqliteMutationWorkerRequest<boolean>({
          transport: { kind: "dedicated", channel: worker },
          operationId: 1,
          completion: "exit",
          dispatch: () => worker.postMessage("start", []),
          onCommitRequest: () => {
            authorize();
            accepted.resolve();
          },
          withWriteAdmission: async (run) => {
            await runOpenClawAgentWorkerWrite(databaseOptions, run);
          },
        }),
      );
    },
    async close() {
      release();
      await exited;
      database.close();
    },
  };
}

test("serves queued work during an accepted commit while retaining writer admission", async () => {
  const fixture = createCommitFixture({ holdAfterApproval: true });
  let settled = false;
  const operation = fixture.run().finally(() => {
    settled = true;
  });
  const writes: number[] = [];
  try {
    await fixture.accepted;
    const first = fixture.nextWrite(() => {
      writes.push(1);
    });
    const second = fixture.nextWrite(() => {
      writes.push(2);
    });
    await setImmediate();
    expect.soft(settled).toBe(false);
    expect.soft(fixture.value()).toBe(1);
    expect.soft(writes).toEqual([]);
    // Retirement refuses pending work, but cannot abandon an already accepted commit.
    revokeSqliteReclamationCommit(fixture.gate);
    fixture.release();
    await expect(operation).resolves.toBe(true);
    await Promise.all([first, second]);
    expect(fixture.value()).toBe(2);
    expect(writes).toEqual([1, 2]);
  } finally {
    await fixture.close();
    await operation.catch(() => {});
  }
});

test.each([
  { outcome: undefined, value: 2, exitCode: 0 },
  { outcome: "rollback" as const, value: 1, exitCode: 0 },
  { outcome: "exit-before-commit" as const, value: 1, exitCode: 7 },
  { outcome: "exit-after-commit" as const, value: 2, exitCode: 9 },
])(
  "joins native settlement before releasing admission ($outcome)",
  async ({ outcome, value, exitCode }) => {
    const fixture = createCommitFixture({ outcome });
    try {
      const operation = fixture.run();
      if (exitCode) {
        await expect(operation).rejects.toThrow(`exited with code ${exitCode}`);
      } else {
        await expect(operation).resolves.toBe(true);
      }
      expect(await fixture.exited).toEqual([exitCode]);
      await fixture.nextWrite(() => {
        fixture.database.exec("BEGIN IMMEDIATE; ROLLBACK");
        expect(fixture.value()).toBe(value);
      });
    } finally {
      await fixture.close();
    }
  },
);

test.each(["authority", "revocation"])(
  "rolls back when %s refuses the pending commit",
  async (refusal) => {
    const fixture = createCommitFixture();
    try {
      await expect(
        fixture.run(() => {
          if (refusal === "authority") {
            throw new Error("retired owner");
          }
          revokeSqliteReclamationCommit(fixture.gate);
        }),
      ).rejects.toThrow(refusal === "authority" ? "retired owner" : "checkpoint expired");
      expect(fixture.value()).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);
