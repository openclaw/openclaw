import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { CronJob } from "../types.js";
import { findCronRunRecoveryInDatabase } from "./run-history-recovery.js";

const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
const schedulerClockUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.schedulerClock);

const children = new Set<ChildProcess>();
let scriptRoot = "";
let runnerScript = "";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-owner-hardening-" });

// Vitest runs afterEach hooks in reverse registration order, so register last
// to observe child exits before the temp and store hooks release their state.
afterEach(async () => {
  const activeChildren = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  await Promise.all(activeChildren.map(waitForExit));
  children.clear();
});

beforeEach(async () => {
  scriptRoot = tempDirs.make("cron-owner-hardening-script-", os.tmpdir());
  runnerScript = path.join(scriptRoot, "runner.mjs");
  await fsPromises.writeFile(
    runnerScript,
    `
      import fs from "node:fs";
      import { CronService } from ${JSON.stringify(serviceUrl.href)};
      import { deserialize } from "node:v8";
      import { Worker } from "node:worker_threads";
      import { createTestGatewayScheduler } from ${JSON.stringify(schedulerClockUrl.href)};
      const [storePath, jobId, mode, outputPath] = process.argv.slice(2);
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
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
        log: logger,
        enqueueSystemEvent() {},
        enqueueSessionEvent() {
          if (mode === "manual-postcommit-crash") process.kill(process.pid, "SIGKILL");
        },
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        runCommandJob: async ({ job }) => {
          if (mode === "manual-postcommit-crash") {
            return { status: "error", error: "expected manual failure" };
          }
          fs.appendFileSync(outputPath, job.agentId + ":" + process.pid + "\\n");
          return { status: "ok", summary: "done" };
        },
      });
      if (mode !== "manual-postcommit-crash") await cron.start();
      if (mode === "crash-activation") {
        await cron.run(jobId, "force");
      }
      if (mode === "manual-postcommit-crash") await cron.run(jobId, "due");
      cron.stop();
    `,
  );
});

function makeCommandJob(id: string, nextRunAtMs: number): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: nextRunAtMs - 1,
    updatedAtMs: nextRunAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
    state: { nextRunAtMs },
  };
}

function spawnRunner(params: {
  storePath: string;
  jobId: string;
  mode: "crash-activation" | "manual-postcommit-crash";
  outputPath: string;
}): ChildProcess {
  const stateDir = resolveOpenClawStateDirForDatabasePath(openOpenClawStateDatabase().path);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(serviceUrl).slice(0, -1),
      runnerScript,
      params.storePath,
      params.jobId,
      params.mode,
      params.outputPath,
    ],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function makeParentService(storePath: string, runCommandJob = vi.fn()) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
  });
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT receipt_id AS receiptId, status, agent_id AS agentId,
              started_at_ms AS startedAtMs
         FROM cron_run_receipts
        WHERE store_key = ? AND job_id = ?
        ORDER BY started_at_ms DESC, receipt_id DESC`,
    )
    .all(cronStoreKey(storePath), jobId) as Array<{
    receiptId: string;
    status: string;
    agentId: string;
    startedAtMs: number;
  }>;
}

describe("cron durable run ownership", () => {
  it("records a queued manual request when the Gateway crashes before activation", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("atomic-activation-crash", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const outputPath = path.join(scriptRoot, `activation-output-${now}`);
    // Hand the seeded database to the child Gateway before simulating its crash.
    await closeOpenClawStateDatabaseAsync();
    const child = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "crash-activation",
      outputPath,
    });

    let diagnostic = "";
    child.stderr?.on("data", (chunk) => {
      diagnostic += String(chunk);
    });
    await waitForExit(child);
    expect(child.signalCode, `child exit ${child.exitCode}: ${diagnostic}`).toBe("SIGKILL");
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
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(recoveredRunner).not.toHaveBeenCalled();
      await expect(recovered.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(recoveredRunner).toHaveBeenCalledOnce();
    } finally {
      recovered.stop();
    }
  });

  it("admits one due payload across overlapping Gateway service callers", async ({ signal }) => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("overlapping-ticks", now - 1);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const entered = createDeferred();
    const finish = createDeferred();
    const runner = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return { status: "ok" as const };
    });
    const callers = [makeParentService(storePath, runner), makeParentService(storePath, runner)];
    const runs = callers.map((cron) => cron.run(job.id, "due"));
    const completed = Promise.all(runs);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, completed, "No due payload was admitted"),
        signal,
      );
      expect(runner).toHaveBeenCalledOnce();
      finish.resolve();
      const results = await completed;
      expect(results.filter((result) => result.ok && "ran" in result && result.ran)).toHaveLength(
        1,
      );
      expect(results.filter((result) => result.ok && "ran" in result && !result.ran)).toHaveLength(
        1,
      );
      expect(runner).toHaveBeenCalledOnce();
      expect(receipts(storePath, job.id)).toMatchObject([{ status: "ok" }]);
    } finally {
      finish.resolve();
      await Promise.allSettled(runs);
      for (const cron of callers) {
        cron.stop();
      }
    }
  });

  it("preserves different jobs activated concurrently by Gateway service callers", async ({
    signal,
  }) => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const firstJob = makeCommandJob("gateway-a-job", now + 60_000);
    const secondJob = makeCommandJob("gateway-b-job", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [firstJob, secondJob] });
    const finish = createDeferred();
    const cases = [firstJob, secondJob].map((job) => {
      const entered = createDeferred();
      const cron = makeParentService(
        storePath,
        vi.fn(async () => {
          entered.resolve();
          await finish.promise;
          return { status: "ok" as const };
        }),
      );
      return { entered, cron, run: cron.run(job.id, "force") };
    });
    try {
      await withinTest(
        Promise.all(
          cases.map(({ entered, run }) =>
            awaitGateBeforeSettlement(entered.promise, run, "Job did not enter its payload"),
          ),
        ),
        signal,
      );

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs.find((job) => job.id === firstJob.id)?.state.runningAtMs).toEqual(
        expect.any(Number),
      );
      expect(persisted.jobs.find((job) => job.id === secondJob.id)?.state.runningAtMs).toEqual(
        expect.any(Number),
      );
      expect(receipts(storePath, firstJob.id)[0]).toMatchObject({ status: "running" });
      expect(receipts(storePath, secondJob.id)[0]).toMatchObject({ status: "running" });
      finish.resolve();
      await expect(Promise.all(cases.map(({ run }) => run))).resolves.toEqual([
        { ok: true, ran: true },
        { ok: true, ran: true },
      ]);
    } finally {
      finish.resolve();
      await Promise.allSettled(cases.map(({ run }) => run));
      for (const { cron } of cases) {
        cron.stop();
      }
    }
  });

  it("records manual task recovery before postcommit notification can crash", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("manual-task-precommit", now - 1);
    job.state.consecutiveErrors = 9;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const child = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "manual-postcommit-crash",
      outputPath: path.join(scriptRoot, `unused-output-${now}`),
    });

    await waitForExit(child);

    expect(child.signalCode).toBe("SIGKILL");
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state).toMatchObject({
      lastRunStatus: "error",
      consecutiveErrors: 10,
    });
    expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "error" });
    const recovered = findCronRunRecoveryInDatabase({
      database: openOpenClawStateDatabase().db,
      jobId: job.id,
      startedAt: persisted!.state.lastRunAtMs!,
      storeKey: cronStoreKey(storePath),
    });
    expect(recovered.finalized?.entry).toMatchObject({
      jobId: job.id,
      status: "error",
    });
  });
});
