import assert from "node:assert/strict";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runCommandBuffered } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { CronService } from "../service.js";
import { createCronStoreHarness, createNoopLogger } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-manual-ack-durability-" });

async function admissionFixture(id: string, count: number, command = false) {
  const { storePath } = await makeStorePath();
  const now = Date.now();
  const job = createDueIsolatedJob({
    id,
    nowMs: now,
    nextRunAtMs: now + (command ? 3_600_000 : 60_000),
  });
  if (command) {
    job.agentId = "main";
    job.payload = { kind: "command", argv: ["unused"] };
    delete job.delivery;
    delete job.deleteAfterRun;
  }
  const blockers = Array.from({ length: count }, (_, index) => ({
    ...job,
    id: `manual-blocker-${index}`,
    name: command ? `manual-blocker-${index}` : job.name,
  }));
  await saveCronStore(storePath, { version: 1, jobs: [...blockers, job] });
  return { storePath, job, blockers };
}

function receipt(runId: string, jobId: string) {
  const sql =
    "SELECT status, error_text FROM cron_run_receipts WHERE request_run_id = ? AND job_id = ?";
  return openOpenClawStateDatabase().db.prepare(sql).get(runId, jobId);
}

it("records the exact acknowledged manual request after SIGKILL before worker activation", async () => {
  const { storePath, job, blockers } = await admissionFixture("manual-before-dispatch", 8, true);
  const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
  const schedulerClockUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.schedulerClock);
  const stateDir = resolveOpenClawStateDirForDatabasePath(openOpenClawStateDatabase().path);
  await closeOpenClawStateDatabaseAsync();
  const node = resolveTestNodeExecPath();
  const runChild = (killAfterAck: boolean) =>
    runCommandBuffered(
      [
        node,
        ...resolveRuntimeWorkerArgv(serviceUrl, node).slice(0, -1),
        "--input-type=module",
        "--eval",
        `
          import { writeSync } from "node:fs";
          import { CronService } from ${JSON.stringify(serviceUrl.href)};
          import { createTestGatewayScheduler } from ${JSON.stringify(schedulerClockUrl.href)};
          let started = 0;
          const { promise: blockersStarted, resolve: reportStarted } = Promise.withResolvers();
          const cron = new CronService({
            scheduler: createTestGatewayScheduler(),
            storePath: ${JSON.stringify(storePath)},
            cronEnabled: true,
            defaultAgentId: "main",
            log: { info() {}, warn() {}, error() {}, debug() {} },
            enqueueSystemEvent() {},
            runIsolatedAgentJob: async () => { throw new Error("unexpected execution"); },
            runCommandJob: async ({ job }) => {
              if (!job.id.startsWith("manual-blocker-")) throw new Error("unexpected execution");
              if (++started === 8) reportStarted();
              await new Promise(() => {});
            },
          });
          await cron.start();
          if (${killAfterAck}) {
            for (const id of ${JSON.stringify(blockers.map((entry) => entry.id))}) {
              void cron.run(id, "force");
            }
            await blockersStarted;
            const ack = await cron.enqueueRun(${JSON.stringify(job.id)}, "force");
            writeSync(1, JSON.stringify(ack) + "\\n");
            process.kill(process.pid, "SIGKILL");
          }
          cron.stop();
        `,
      ],
      {
        timeoutMs: 20_000,
        killGraceMs: 500,
        env: { OPENCLAW_STATE_DIR: stateDir, HOME: path.dirname(stateDir) },
        maxOutputBytes: { stdout: 16_384, stderr: 16_384 },
      },
    );

  const killed = await runChild(true);
  expect(killed.signal, killed.stderr.toString()).toBe("SIGKILL");
  const ack = JSON.parse(killed.stdout.toString());
  expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
  const restarted = await runChild(false);
  expect(restarted.code, restarted.stderr.toString()).toBe(0);
  expect(receipt(ack.runId, job.id)).toEqual({
    status: "skipped",
    error_text: "cron: queued request lost its launch context",
  });
  const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
  expect(persisted?.state).toMatchObject({
    nextRunAtMs: job.state.nextRunAtMs,
  });
  expect(persisted?.state.queuedAtMs).toBeUndefined();
  expect(persisted?.state.runningAtMs).toBeUndefined();
}, 45_000);

it.each(["removed", "write-failed"] as const)(
  "preserves accounting on manual admission failure: %s",
  async (failure) => {
    const { storePath, job, blockers } = await admissionFixture(
      `manual-${failure}`,
      failure === "removed" ? 8 : 0,
    );
    const finished = createDeferredCore();
    const blockersStarted = createDeferredCore();
    const releaseBlockers = createDeferredCore();
    let blockerCount = 0;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent() {},
      runIsolatedAgentJob: async (params) => {
        if (blockers.some((entry) => entry.id === params.job.id)) {
          if (++blockerCount === blockers.length) {
            blockersStarted.resolve();
          }
          await releaseBlockers.promise;
          return { status: "ok" };
        }
        return runIsolatedAgentJob();
      },
      onEvent: (event) => {
        if (event.jobId === job.id && event.action === "finished") {
          finished.resolve();
        }
      },
    });
    inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    const database = openOpenClawStateDatabase().db;
    const completion = createCronMutationCompletion("cron.run");
    assert(completion, "Expected cron mutation completion");
    if (failure === "write-failed") {
      database.exec(`CREATE TRIGGER reject_manual_receipt BEFORE INSERT ON cron_run_receipts
        WHEN NEW.store_key = '${cronStoreKey(storePath).replaceAll("'", "''")}'
          AND NEW.job_id = '${job.id}'
        BEGIN SELECT RAISE(ABORT, 'manual receipt unavailable'); END;`);
    }
    const active = blockers.map((entry) => cron.run(entry.id, "force"));
    try {
      if (blockers.length > 0) {
        await blockersStarted.promise;
      }
      const pending = completion.run(() => cron.enqueueRun(job.id, "force"));
      if (failure === "write-failed") {
        await expect(pending).rejects.toThrow("manual receipt unavailable");
        expect(completion.isCommitted()).toBe(false);
      } else {
        const ack = await pending;
        expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
        assert(ack.ok && "runId" in ack, "Expected manual run acknowledgement");
        expect(completion.isCommitted()).toBe(true);
        await cron.remove(job.id);
        releaseBlockers.resolve();
        await Promise.all(active);
        await finished.promise;
        expect(receipt(ack.runId, job.id)).toEqual({
          status: "skipped",
          error_text: "cron: queued job was removed",
        });
      }
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      if (failure === "removed") {
        expect(persisted).toBeUndefined();
      } else {
        expect(persisted?.state).toMatchObject({
          nextRunAtMs: job.state.nextRunAtMs,
        });
        expect(persisted?.state.queuedAtMs).toBeUndefined();
      }
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_manual_receipt");
      releaseBlockers.resolve();
      await Promise.allSettled(active);
      cron.stop();
      await cron.waitForIdle();
    }
  },
);
