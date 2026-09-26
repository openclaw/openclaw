import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { clearCommandLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { runCommandBuffered } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { CronService } from "../service.js";
import { createCronStoreHarness, createNoopLogger } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-manual-ack-durability-" });

it("records the exact acknowledged manual run after SIGKILL before command-lane dispatch", async () => {
  const { storePath } = await makeStorePath();
  const now = Date.now();
  const job: CronJob = {
    id: "manual-before-dispatch",
    agentId: "main",
    name: "manual-before-dispatch",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["unused"] },
    state: { nextRunAtMs: now + 3_600_000 },
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
  const queueUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.commandQueue);
  const stateDir = resolveOpenClawStateDirForDatabasePath(openOpenClawStateDatabase().path);
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
          import { setCommandLaneConcurrency } from ${JSON.stringify(queueUrl.href)};
          const cron = new CronService({
            storePath: ${JSON.stringify(storePath)},
            cronEnabled: true,
            defaultAgentId: "main",
            log: { info() {}, warn() {}, error() {}, debug() {} },
            enqueueSystemEvent() {}, requestHeartbeat() {},
            runIsolatedAgentJob: async () => { throw new Error("unexpected execution"); },
            runCommandJob: async () => { throw new Error("unexpected execution"); },
          });
          await cron.start();
          if (${killAfterAck}) {
            setCommandLaneConcurrency("cron", 0);
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
  const receipt = openOpenClawStateDatabase()
    .db.prepare(
      "SELECT status, error_text FROM cron_run_receipts WHERE request_run_id = ? AND job_id = ?",
    )
    .get(ack.runId, job.id);
  expect(receipt).toEqual({
    status: "interrupted",
    error_text: "cron: queued run interrupted because owner is unavailable",
  });
  const persisted = (await loadCronStore(storePath)).jobs[0];
  expect(persisted?.state.nextRunAtMs).toBe(job.state.nextRunAtMs);
  expect(persisted?.state.queuedAtMs).toBeUndefined();
  expect(persisted?.state.runningAtMs).toBeUndefined();
}, 45_000);

it.each(["cleared", "write-failed"] as const)(
  "preserves accounting on manual admission failure: %s",
  async (failure) => {
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency("cron", 0);
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = createDueIsolatedJob({
      id: `manual-${failure}`,
      nowMs: now,
      nextRunAtMs: now + 60_000,
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const finished = createDeferredCore();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      storePath,
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve();
        }
      },
    });
    inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    const database = openOpenClawStateDatabase().db;
    const completion = createCronMutationCompletion("cron.run");
    if (!completion) {
      throw new Error("Expected cron mutation completion");
    }
    if (failure === "write-failed") {
      database.exec(`CREATE TEMP TRIGGER reject_manual_receipt BEFORE INSERT ON cron_run_receipts
        BEGIN SELECT RAISE(ABORT, 'manual receipt unavailable'); END;`);
    }
    try {
      const pending = completion.run(() => cron.enqueueRun(job.id, "force"));
      if (failure === "write-failed") {
        await expect(pending).rejects.toThrow("manual receipt unavailable");
        expect(completion.isCommitted()).toBe(false);
      } else {
        const ack = await pending;
        expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
        if (!ack.ok || !("runId" in ack)) {
          throw new Error("Expected manual run acknowledgement");
        }
        expect(completion.isCommitted()).toBe(true);
        expect(clearCommandLane("cron")).toBe(1);
        await finished.promise;
        expect(
          database
            .prepare("SELECT status, error_text FROM cron_run_receipts WHERE request_run_id = ?")
            .get(ack.runId),
        ).toEqual({
          status: "skipped",
          error_text: "cron reservation released before completion",
        });
      }
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.nextRunAtMs).toBe(job.state.nextRunAtMs);
      expect(persisted?.state.queuedAtMs).toBeUndefined();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_manual_receipt");
      cron.stop();
      resetCommandQueueStateForTest();
    }
  },
);
