import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { makeCronRecoveryJob } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { findCronRunRecoveryInDatabase } from "./run-history-recovery.js";

const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
const schedulerClockUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.schedulerClock);

const children = new Set<ChildProcess>();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-owner-hardening-" });

// Vitest runs afterEach hooks in reverse registration order, so register last
// to observe child exits before the temp and store hooks release their state.
afterEach(async () => {
  const activeChildren = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  activeChildren.forEach((child) => child.kill("SIGKILL"));
  await Promise.all(activeChildren.map(waitForExit));
  children.clear();
});

beforeEach(() => vi.useRealTimers());

async function crashRunner(
  storePath: string,
  jobId: string,
  mode: "crash-activation" | "manual-postcommit-crash",
) {
  const runnerScript = path.join(tempDirs.make("cron-owner-hardening-script-"), "runner.mjs");
  const outputPath = `${runnerScript}.output`;
  await fsPromises.writeFile(
    runnerScript,
    `
      import fs from "node:fs";
      import { CronService } from ${JSON.stringify(serviceUrl.href)};
      import { deserialize } from "node:v8";
      import { Worker } from "node:worker_threads";
      import { createTestGatewayScheduler } from ${JSON.stringify(schedulerClockUrl.href)};
      const [storePath, jobId, mode, outputPath] = process.argv.slice(2);
      let activationClock = Date.now();
      if (mode === "crash-activation") {
        const originalPost = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...args) {
          if (message?.type === "execute" && message.input instanceof Uint8Array) {
            const command = deserialize(message.input);
            if (command?.type === "cron.drainQueue" && command.input?.requests?.length > 0) {
              // The request committed; crash before the worker can activate it.
              process.kill(process.pid, "SIGKILL");
            }
          }
          return originalPost.call(this, message, ...args);
        };
      }
      const cron = new CronService({
        ...(mode === "crash-activation" ? { nowMs: () => ++activationClock } : {}),
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: true,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent() {
          if (mode === "manual-postcommit-crash") process.kill(process.pid, "SIGKILL");
        },
        requestHeartbeat() {},
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        runCommandJob: async () => {
          if (mode === "manual-postcommit-crash") {
            return { status: "error", error: "expected manual failure" };
          }
          fs.writeFileSync(outputPath, "ran");
          return { status: "ok" };
        },
      });
      if (mode !== "manual-postcommit-crash") await cron.start();
      await cron.run(jobId, mode === "crash-activation" ? "force" : "due");
      cron.stop();
    `,
  );
  const stateDir = resolveOpenClawStateDirForDatabasePath(openOpenClawStateDatabase().path);
  const args = [runnerScript, storePath, jobId, mode, outputPath];
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(serviceUrl).slice(0, -1), ...args],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let diagnostic = "";
  child.stderr?.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  await waitForExit(child);
  expect(child.signalCode, `child exit ${child.exitCode}: ${diagnostic}`).toBe("SIGKILL");
  return outputPath;
}

function makeCommandJob(id: string, nextRunAtMs: number): CronJob {
  return { ...makeCronRecoveryJob(id, nextRunAtMs), state: { nextRunAtMs } };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
}

function makeParentService(storePath: string, runCommandJob = vi.fn()) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
  });
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT status, started_at_ms AS startedAtMs
         FROM cron_run_receipts
        WHERE store_key = ? AND job_id = ?
        ORDER BY started_at_ms DESC, receipt_id DESC`,
    )
    .all(cronStoreKey(storePath), jobId) as Array<{
    status: string;
    startedAtMs: number;
  }>;
}

async function seed(...jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  return storePath;
}

it("records a queued manual request when the Gateway crashes before activation", async () => {
  const job = makeCommandJob("atomic-activation-crash", Date.now() + 60_000);
  const storePath = await seed(job);
  // Hand the seeded database to the child Gateway before simulating its crash.
  await closeOpenClawStateDatabaseAsync();
  const outputPath = await crashRunner(storePath, job.id, "crash-activation");
  expect(fs.existsSync(outputPath)).toBe(false);
  const queued = (await loadCronStore(storePath)).jobs[0];
  expect(queued?.state.queuedAtMs).toEqual(expect.any(Number));
  expect(queued?.state.runningAtMs).toBeUndefined();
  expect(receipts(storePath, job.id)).toMatchObject([
    { status: "running", startedAtMs: queued?.state.queuedAtMs },
  ]);

  const recoveredRunner = vi.fn(async () => ({ status: "ok" as const }));
  const recovered = makeParentService(storePath, recoveredRunner);
  try {
    await recovered.start();
    expect(receipts(storePath, job.id)).toMatchObject([{ status: "skipped" }]);
    const state = (await loadCronStore(storePath)).jobs[0]?.state;
    expect([state?.queuedAtMs, state?.runningAtMs]).toEqual([undefined, undefined]);
    expect(recoveredRunner).not.toHaveBeenCalled();
    await expect(recovered.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(recoveredRunner).toHaveBeenCalledOnce();
  } finally {
    recovered.stop();
  }
});

it.each([false, true])(
  "preserves overlapping Gateway runs (distinct jobs: %s)",
  async (distinct, { signal }) => {
    const jobs = (distinct ? ["gateway-a-job", "gateway-b-job"] : ["overlapping-ticks"]).map((id) =>
      makeCommandJob(id, Date.now() + (distinct ? 60_000 : -1)),
    );
    const storePath = await seed(...jobs);
    const finish = createDeferred();
    const gates = jobs.map(() => createDeferred());
    const runners = gates.map((entered) =>
      vi.fn(async () => {
        entered.resolve();
        await finish.promise;
        return { status: "ok" as const };
      }),
    );
    const callers = [0, distinct ? 1 : 0].map((index) =>
      makeParentService(storePath, runners[index]),
    );
    const runs = callers.map((cron, index) =>
      cron.run(jobs[distinct ? index : 0].id, distinct ? "force" : "due"),
    );
    const completed = Promise.all(runs);
    try {
      const admissions = gates.map((gate, index) =>
        awaitGateBeforeSettlement(
          gate.promise,
          distinct ? runs[index] : completed,
          "No payload was admitted",
        ),
      );
      await withinTest(Promise.all(admissions), signal);
      expect(runners.map((runner) => runner.mock.calls.length)).toEqual(jobs.map(() => 1));
      if (distinct) {
        const { jobs: persisted } = await loadCronStore(storePath);
        expect(
          jobs.map(({ id }) => persisted.find((row) => row.id === id)?.state.runningAtMs),
        ).toEqual(jobs.map(() => expect.any(Number)));
        expect(jobs.map(({ id }) => receipts(storePath, id)[0])).toMatchObject(
          jobs.map(() => ({ status: "running" })),
        );
      }
      finish.resolve();
      const outcomes = [true, distinct].map((ran) => ({ ok: true, ran }));
      expect(await completed).toEqual(
        distinct
          ? outcomes
          : expect.arrayContaining(outcomes.map((outcome) => expect.objectContaining(outcome))),
      );
      expect(runners.map((runner) => runner.mock.calls.length)).toEqual(jobs.map(() => 1));
      if (!distinct) {
        expect(receipts(storePath, jobs[0].id)).toMatchObject([{ status: "ok" }]);
      }
    } finally {
      finish.resolve();
      await Promise.allSettled(runs);
      callers.forEach((cron) => cron.stop());
    }
  },
);

it("records manual task recovery before postcommit notification can crash", async () => {
  const job = makeCommandJob("manual-task-precommit", Date.now() - 1);
  job.state.consecutiveErrors = 9;
  const storePath = await seed(job);
  await crashRunner(storePath, job.id, "manual-postcommit-crash");
  const persisted = (await loadCronStore(storePath)).jobs[0];
  expect(persisted?.state).toMatchObject({ lastRunStatus: "error", consecutiveErrors: 10 });
  expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "error" });
  const recovered = findCronRunRecoveryInDatabase({
    database: openOpenClawStateDatabase().db,
    jobId: job.id,
    startedAt: persisted!.state.lastRunAtMs!,
    storeKey: cronStoreKey(storePath),
  });
  expect(recovered.finalized?.entry).toMatchObject({ jobId: job.id, status: "error" });
});
