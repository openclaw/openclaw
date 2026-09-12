import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronJobsStoreChanges, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { isCronRunTriggerStateRetiredInDatabase } from "../store/run-receipt-trigger-state.js";
import { cronTaskRecordStoreKey } from "../task-run-detail.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob } from "../types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-shared-runtime-" });

const log = { debug() {}, info() {}, warn() {}, error() {} };

function createDisabledService(storePath: string): CronService {
  return new CronService({
    cronEnabled: false,
    storePath,
    log,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    async runIsolatedAgentJob() {
      return { status: "ok" as const, summary: "unused" };
    },
  });
}

async function addCanary(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `canary-${suffix}`,
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: 86_400_000,
      anchorMs: Date.now() + 86_400_000,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run canary" },
  });
}

async function addTarget(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `target-${suffix}`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "target" },
  });
}

const schedulerChildScript = String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
const runs = JSON.parse(process.env.OPENCLAW_CRON_SHARED_STORE_RUNS);
const { CronService } = await import(pathToFileURL(path.join(process.cwd(), "src/cron/service.ts")).href);
const { openOpenClawStateDatabase } = await import(pathToFileURL(path.join(process.cwd(), "src/state/openclaw-state-db.ts")).href);
const log = { debug() {}, info() {}, warn() {}, error() {} };
for (const run of runs) {
  const cron = new CronService({
    cronEnabled: true,
    storePath: run.storePath,
    nowMs: () => run.startedAtMs ?? Date.now(),
    log,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    async runIsolatedAgentJob() {
      if (run.leavePending) {
        openOpenClawStateDatabase().db.exec(
          "CREATE TEMP TRIGGER reject_scheduler_completion BEFORE UPDATE ON cron_jobs " +
          "WHEN json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL " +
          "AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL " +
          "BEGIN SELECT RAISE(ABORT, 'scheduler completion unavailable'); END;",
        );
      }
      return { status: "ok", summary: "scheduler child completed" };
    },
  });
  try {
    await cron.start();
    const result = await cron.run(run.jobId, "force");
    if (run.leavePending || !result.ok || !("ran" in result) || result.ran !== true) {
      throw new Error("scheduler child did not complete the expected run " + run.jobId + ": " + JSON.stringify(result));
    }
  } catch (error) {
    if (!run.leavePending || !String(error).includes("scheduler completion unavailable")) {
      throw error;
    }
  } finally {
    openOpenClawStateDatabase().db.exec("DROP TRIGGER IF EXISTS reject_scheduler_completion");
    cron.stop();
  }
}
`;

function runSchedulerChild(
  runs: Array<{ storePath: string; jobId: string; startedAtMs?: number; leavePending?: boolean }>,
) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(process.cwd(), "scripts/tsx.mjs"),
      "--input-type=module",
      "--eval",
      schedulerChildScript,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CRON_SHARED_STORE_RUNS: JSON.stringify(runs),
      },
      timeout: 60_000,
    },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
}

const overlappingRunsChildScript = String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { storePath, jobId, nowMs } = JSON.parse(process.env.OPENCLAW_CRON_SHARED_STORE_RUNS);
const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
const { CronService } = await load("src/cron/service.ts");
const { loadCronStore } = await load("src/cron/store.ts");
const { openOpenClawStateDatabase } = await load("src/state/openclaw-state-db.ts");
const { createDeferred } = await load("test/helpers/promise.ts");
const started = [createDeferred(), createDeferred()];
const completions = [createDeferred(), createDeferred()];
const advance = createDeferred();
process.once("message", () => advance.resolve());
let payloads = 0;
const cron = new CronService({
  cronEnabled: true,
  storePath,
  nowMs: () => nowMs,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  enqueueSystemEvent() {},
  requestHeartbeat() {},
  async runIsolatedAgentJob() {
    const index = payloads++;
    assert.ok(index < 2, "startup must not replay either payload");
    started[index].resolve();
    await completions[index].promise;
    return { status: "ok", summary: "completed payload " + (index + 1) };
  },
});
let database;
try {
  cron.pauseScheduling();
  await cron.start();
  const first = cron.run(jobId, "force");
  await Promise.race([
    started[0].promise,
    first.then(() => { throw new Error("first run did not enter its payload"); }),
  ]);
  await cron.update(jobId, { schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs } });
  process.send("ready");
  await advance.promise;
  completions[0].resolve();
  assert.deepEqual(await first, { ok: true, ran: true });

  const second = cron.run(jobId, "force");
  await Promise.race([
    started[1].promise,
    second.then(() => { throw new Error("second run did not enter its payload"); }),
  ]);
  const activated = (await loadCronStore(storePath)).jobs.find((job) => job.id === jobId);
  assert.equal(activated.state.runningAtMs, nowMs);
  assert.equal(activated.state.runningScheduleChangeId, undefined);
  database = openOpenClawStateDatabase().db;
  database.exec(
    "CREATE TEMP TRIGGER reject_successor_row BEFORE UPDATE ON cron_jobs WHEN NEW.job_id = '" +
    jobId.replaceAll("'", "''") +
    "' BEGIN SELECT RAISE(ABORT, 'successor row unavailable'); END;"
  );
  completions[1].resolve();
  await assert.rejects(second, /successor row unavailable/);
  assert.equal(payloads, 2);
} finally {
  database?.exec("DROP TRIGGER IF EXISTS reject_successor_row");
  for (const completion of completions) completion.resolve();
  cron.stop();
  process.disconnect();
}
`;

describe("scheduler-disabled shared-store mutations", () => {
  it("cannot overwrite runtime committed by a scheduler process", async () => {
    const cases = await Promise.all(
      ["add", "update", "remove", "same-job-update", "state-update"].map(async (operation) => {
        const { storePath } = await makeStorePath();
        const cron = createDisabledService(storePath);
        await cron.start();
        const canary = await addCanary(cron, operation);
        const target = ["update", "remove"].includes(operation)
          ? await addTarget(cron, operation)
          : undefined;
        return { canary, cron, operation, storePath, target };
      }),
    );

    runSchedulerChild(cases.map(({ canary, storePath }) => ({ jobId: canary.id, storePath })));

    for (const testCase of cases) {
      const before = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(before?.state.lastStatus).toBe("ok");
      expect(before?.state.lastRunAtMs).toEqual(expect.any(Number));

      if (testCase.operation === "add") {
        const added = await addTarget(testCase.cron, "added");
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some((job) => job.id === added.id),
        ).toBe(true);
      } else if (testCase.operation === "update" && testCase.target) {
        await testCase.cron.updateWithPrecondition(
          testCase.target.id,
          { name: "target-updated" },
          () => {},
        );
        expect(
          (await loadCronStore(testCase.storePath)).jobs.find(
            (job) => job.id === testCase.target?.id,
          )?.name,
        ).toBe("target-updated");
      } else if (testCase.operation === "same-job-update") {
        await testCase.cron.update(testCase.canary.id, { name: "canary-updated" });
      } else if (testCase.operation === "state-update") {
        await testCase.cron.update(testCase.canary.id, { state: { consecutiveErrors: 7 } });
      } else if (testCase.target) {
        await testCase.cron.remove(testCase.target.id);
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some(
            (job) => job.id === testCase.target?.id,
          ),
        ).toBe(false);
      }

      const after = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(after?.state).toEqual(
        testCase.operation === "state-update"
          ? { ...before?.state, consecutiveErrors: 7 }
          : before?.state,
      );
      testCase.cron.stop();
    }
  }, 90_000);

  it("keeps receipt identity coupled to a marker edited during concurrent admission", async () => {
    const startedAtMs = Date.now();
    const cases = await Promise.all(
      ["same timestamp", "different timestamp", "ordinary edit", "failed replacement"].map(
        async (operation) => {
          const { storePath } = await makeStorePath();
          const cron = createDisabledService(storePath);
          const job = await addCanary(cron, operation);
          return { operation, storePath, cron, job, entered: createDeferred() };
        },
      ),
    );
    const resumeUpdates = createDeferred();
    const updates = Promise.allSettled(
      cases.map(({ cron, job, operation, entered }) =>
        cron.updateWithPrecondition(
          job.id,
          {
            agentId: "beta",
            state: {
              ...(operation === "ordinary edit"
                ? {}
                : { runningAtMs: startedAtMs + (operation === "same timestamp" ? 0 : 1) }),
              triggerState: { owner: "saved edit" },
            },
          },
          async (snapshot) => {
            expect(snapshot.state.runningAtMs).toBeUndefined();
            entered.resolve();
            await resumeUpdates.promise;
          },
        ),
      ),
    );
    const database = openOpenClawStateDatabase().db;
    try {
      await Promise.all(cases.map(({ entered }) => entered.promise));
      runSchedulerChild(
        cases.map(({ job, storePath }) => ({
          jobId: job.id,
          storePath,
          startedAtMs,
          leavePending: true,
        })),
      );
      const admitted = cases.map(({ storePath, job }) => {
        const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        expect(receipt).toBeDefined();
        return receipt!;
      });
      for (const [index, { operation, storePath }] of cases.entries()) {
        expect((await loadCronStore(storePath)).jobs[0]?.state, operation).toMatchObject({
          runningAtMs: startedAtMs,
          runningReceiptId: admitted[index]!.receiptId,
        });
      }
      const failedJob = cases.find(({ operation }) => operation === "failed replacement")!.job;
      database.exec(`
        CREATE TEMP TRIGGER reject_shared_marker_update
        BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = '${failedJob.id}'
        BEGIN
          SELECT RAISE(ABORT, 'marker update unavailable');
        END;
      `);
      resumeUpdates.resolve();
      const results = await updates;
      for (const [index, { operation, storePath }] of cases.entries()) {
        const result = results[index]!;
        const receipt = admitted[index]!;
        const failed = operation === "failed replacement";
        expect(result.status, operation).toBe(failed ? "rejected" : "fulfilled");
        if (result.status === "rejected") {
          expect(String(result.reason)).toContain("marker update unavailable");
        }
        const persisted = (await loadCronStore(storePath)).jobs[0]!;
        expect(persisted.state.runningAtMs, operation).toBe(
          startedAtMs + (operation === "different timestamp" ? 1 : 0),
        );
        expect(persisted.state.runningReceiptId, operation).toBe(
          operation === "different timestamp" ? undefined : receipt.receiptId,
        );
        expect(persisted.state.triggerState, operation).toEqual(
          failed ? undefined : { owner: "saved edit" },
        );
        expect(
          runOpenClawStateWriteTransaction(({ db }) =>
            isCronRunTriggerStateRetiredInDatabase({ database: db, handle: receipt }),
          ),
          operation,
        ).toBe(!failed);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: persisted.id }), operation).toEqual(
          failed ? receipt : undefined,
        );
      }
      const retained = cases.find(({ operation }) => operation === "same timestamp")!;
      await retained.cron.update(retained.job.id, { state: { runningAtMs: startedAtMs + 2 } });
      const replaced = (await loadCronStore(retained.storePath)).jobs[0]!;
      expect(replaced.state.runningAtMs).toBe(startedAtMs + 2);
      expect(replaced.state.runningReceiptId).toBeUndefined();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_shared_marker_update");
      resumeUpdates.resolve();
      await updates;
      for (const { cron } of cases) {
        cron.stop();
      }
    }
  }, 90_000);

  it("retires a successor when an edit was prepared against an earlier edited run", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-09-12T13:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const deps = {
      storePath,
      nowMs: () => nowMs,
      log,
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob,
    };
    const editor = new CronService({ ...deps, cronEnabled: false });
    const restarted = new CronService({ ...deps, cronEnabled: true });
    restarted.pauseScheduling();
    const job = await editor.add({
      name: "passive cadence edit",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: nowMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run the shared-store payload." },
      delivery: { mode: "none" },
    });
    const storeKey = cronStoreKey(storePath);
    const readTasks = () =>
      listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
        runtime: "cron",
        sourceId: job.id,
      }).filter((task) => cronTaskRecordStoreKey(task) === storeKey);
    const child = spawn(
      process.execPath,
      [
        "--import",
        path.join(process.cwd(), "scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        overlappingRunsChildScript,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_CRON_SHARED_STORE_RUNS: JSON.stringify({ storePath, jobId: job.id, nowMs }),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        timeout: 60_000,
      },
    );
    const stderr = createBoundedChildOutput();
    child.stderr?.on("data", stderr.append);
    const closed = once(child, "close");
    try {
      const [ready] = await Promise.race([
        once(child, "message"),
        closed.then(() => {
          throw new Error(`Scheduler exited before the edit barrier: ${stderr.text()}`);
        }),
      ]);
      expect(ready).toBe("ready");
      const before = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      const firstReceipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      if (!before || !firstReceipt) {
        throw new Error("Expected the first edited run to remain active.");
      }
      expect(before.state.runningAtMs).toBe(nowMs);
      const firstTasks = readTasks();
      expect(firstTasks).toHaveLength(1);

      // A child owns execution so the passive editor can hold its store lock
      // while both runs advance. Identical clocks cannot identify the new edit.
      const acknowledged = await editor.updateWithPrecondition(
        job.id,
        { schedule: { kind: "every", everyMs: 120_000, anchorMs: nowMs } },
        async (snapshot) => {
          expect(snapshot.schedule).toEqual(before.schedule);
          expect(snapshot.state.runningAtMs).toBe(firstReceipt.startedAtMs);
          expect(snapshot.state.runningScheduleChangeId).toBe(before.state.runningScheduleChangeId);
          child.send("advance");
          await closed;
          expect(child.exitCode, stderr.text()).toBe(0);
          expect(child.signalCode).toBeNull();
        },
      );
      expect(acknowledged.state.nextRunAtMs).toBe(nowMs + 120_000);
      const after = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      const secondReceipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      if (!secondReceipt) {
        throw new Error("Expected the second run to retain its pending receipt.");
      }
      expect(secondReceipt.receiptId).not.toBe(firstReceipt.receiptId);
      expect(secondReceipt.startedAtMs).toBe(nowMs);
      expect(after?.state.runningAtMs).toBe(nowMs);
      expect(after?.state.nextRunAtMs).toBe(acknowledged.state.nextRunAtMs);
      const tasks = readTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.filter((task) => task.taskId !== firstTasks[0]?.taskId)).toHaveLength(1);
      const readHistory = () => readCronTaskRunHistoryPage({ storeKey, jobId: job.id }).entries;
      const history = readHistory();
      expect(history).toHaveLength(2);
      for (const entry of history) {
        expect(entry).toMatchObject({
          runAtMs: nowMs,
          status: "ok",
          completionStatus: "succeeded",
          nextRunAtMs: nowMs + 60_000,
        });
      }

      await restarted.start();
      const recovered = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      expect(recovered?.enabled).toBe(true);
      expect(recovered?.schedule).toEqual(acknowledged.schedule);
      expect(recovered?.state.nextRunAtMs).toBe(acknowledged.state.nextRunAtMs);
      expect(recovered?.state.runningAtMs).toBeUndefined();
      expect(readHistory()).toEqual(history);
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
          .get(secondReceipt.receiptId),
      ).toMatchObject({ status: "ok" });
      expect(before.state.runningScheduleChangeId).toEqual(expect.any(String));
      expect(after?.state.runningScheduleChangeId).toEqual(expect.any(String));
      expect(after?.state.runningScheduleChangeId).not.toBe(before.state.runningScheduleChangeId);
    } finally {
      editor.stop();
      restarted.stop();
      await stopChildProcess(child, 1_000);
    }
  }, 90_000);

  it("rejects a stale config mutation instead of overwriting its peer", async () => {
    const { storePath } = await makeStorePath();
    const seed = createDisabledService(storePath);
    const target = await addTarget(seed, "config-conflict");
    seed.stop();

    const cron = new CronService({
      cronEnabled: false,
      storePath,
      log,
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      async runIsolatedAgentJob() {
        return { status: "ok" as const, summary: "unused" };
      },
      async listConfiguredChannels() {
        const peerStore = await loadCronStore(storePath);
        const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
        if (!peerTarget) {
          throw new Error("missing peer target");
        }
        peerTarget.name = "peer-update";
        await saveCronStore(storePath, peerStore);
        return [];
      },
    });

    await expect(
      cron.update(target.id, {
        delivery: { mode: "webhook", to: "https://example.com/cron" },
      }),
    ).rejects.toThrow("changed after it was read");
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.name).toBe("peer-update");
    expect(persisted?.delivery).toBeUndefined();
    cron.stop();
  });

  it("rejects deleting a row whose config a peer rewrote", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDisabledService(storePath);
    const target = await addTarget(cron, "delete-conflict");
    cron.stop();
    const baseline = await loadCronStore(storePath);
    const peerStore = structuredClone(baseline);
    const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
    if (!peerTarget) {
      throw new Error("missing peer delete target");
    }
    peerTarget.description = "peer rewrite";
    await saveCronStore(storePath, peerStore);

    await expect(
      saveCronJobsStoreChanges(storePath, baseline, { version: 1, jobs: [] }),
    ).rejects.toThrow("changed after it was read");
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.description).toBe("peer rewrite");
  });
});
