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

type CommitOptions = { holdAfterApproval?: boolean; outcome?: "rollback" | "exit-before-commit" };
function createCommitFixture(options: CommitOptions = {}) {
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
  let pending: Promise<boolean> | undefined;
  return {
    database,
    gate,
    accepted: accepted.promise,
    exited,
    release,
    value: () => database.prepare("SELECT value FROM proof").get()?.value,
    nextWrite: (run: () => void) => runOpenClawAgentWriteAdmission(databaseOptions, run),
    run(assertCurrent: () => void = () => {}) {
      pending = withSqliteReclamationAuthorization(gate, database, assertCurrent, (authorize) =>
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
      return pending;
    },
    async [Symbol.asyncDispose]() {
      release();
      await exited;
      database.close();
      await pending?.catch(() => {});
    },
  };
}

test("serves queued work during an accepted commit while retaining writer admission", async () => {
  await using fixture = createCommitFixture({ holdAfterApproval: true });
  let settled = false;
  const operation = fixture.run().finally(() => {
    settled = true;
  });
  const writes: number[] = [];
  await fixture.accepted;
  const queued = [1, 2].map((value) =>
    fixture.nextWrite(() => {
      writes.push(value);
    }),
  );
  await setImmediate();
  expect.soft({ settled, value: fixture.value(), writes }).toEqual({
    settled: false,
    value: 1,
    writes: [],
  });
  // Retirement refuses pending work, but cannot abandon an already accepted commit.
  revokeSqliteReclamationCommit(fixture.gate);
  fixture.release();
  await expect(operation).resolves.toBe(true);
  await Promise.all(queued);
  expect({ value: fixture.value(), writes }).toEqual({ value: 2, writes: [1, 2] });
});

test.each([
  { outcome: "rollback" as const, value: 1, exitCode: 0 },
  { outcome: "exit-before-commit" as const, value: 1, exitCode: 7 },
])(
  "joins native settlement before releasing admission ($outcome)",
  async ({ outcome, value, exitCode }) => {
    await using fixture = createCommitFixture({ outcome });
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
  },
);

test.each(["authority", "revocation"])(
  "rolls back when %s refuses the pending commit",
  async (refusal) => {
    await using fixture = createCommitFixture();
    await expect(
      fixture.run(() => {
        if (refusal === "authority") {
          throw new Error("retired owner");
        }
        revokeSqliteReclamationCommit(fixture.gate);
      }),
    ).rejects.toThrow(refusal === "authority" ? "retired owner" : "checkpoint expired");
    expect(fixture.value()).toBe(1);
  },
);
