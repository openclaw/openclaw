import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-stream-trigger-" });
async function withStream(
  input: Partial<CronJobCreate>,
  deps: Partial<CronServiceDeps>,
  run: (cron: CronService, job: CronJob, storePath: string) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
  await cron.start();
  try {
    const job = await cron.add({
      name: "stream",
      enabled: true,
      schedule: { kind: "stream", command: ["echo"] },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "base" },
      ...input,
    });
    await run(cron, job, storePath);
  } finally {
    cron.stop();
  }
}

function runBatch(
  cron: CronService,
  job: CronJob,
  batch: string,
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "error" | "busy") => void,
) {
  return cron.run(job.id, "force", {
    evaluateTrigger: true,
    streamBatch: batch,
    payload: job.payload,
    onTriggerDisposition,
  });
}

describe("cron stream trigger composition", () => {
  it("drops a fire:false batch and persists gate state", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
      state: { seen: true },
    }));
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    await withStream(
      { trigger: { script: "json({ fire: true })" } },
      { evaluateCronTrigger, runIsolatedAgentJob },
      async (cron, job) => {
        await runBatch(cron, job, "quiet batch");
        expect(evaluateCronTrigger).toHaveBeenCalledWith(
          expect.objectContaining({ streamBatch: "quiet batch" }),
        );
        expect(cron.getJob(job.id)?.state.triggerState).toEqual({ seen: true });
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      },
    );
  });

  it("composes a final batch and rotates source identity when a once trigger disables the stream", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      message: "gate message",
      state: { seen: true },
    }));
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    await withStream(
      { trigger: { script: "json({ fire: true })" } },
      { evaluateCronTrigger, runIsolatedAgentJob },
      async (cron, job) => {
        const configured = await cron.update(job.id, {
          trigger: { script: "json({ fire: true })", once: true },
        });
        const identity = configured.state.streamSourceIdentity;
        expect(identity).toEqual(expect.any(String));
        await runBatch(cron, job, "final batch");
        expect(runIsolatedAgentJob).toHaveBeenCalledWith(
          expect.objectContaining({ message: "base\n\ngate message\n\nfinal batch" }),
        );
        expect(cron.getJob(job.id)?.enabled).toBe(false);
        expect(cron.getJob(job.id)?.state.streamSourceIdentity).not.toBe(identity);
      },
    );
  });

  it("appends the gate message and batch to a main-session system event", async () => {
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    await withStream(
      {
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "base" },
        trigger: { script: "return { fire: true }" },
      },
      {
        runSessionEvent,
        evaluateCronTrigger: vi.fn(async () => ({
          kind: "evaluated" as const,
          fire: true,
          message: "gate message",
        })),
      },
      async (cron, job) => {
        await runBatch(cron, job, "firing batch");
        expect(runSessionEvent).toHaveBeenCalledWith(
          expect.objectContaining({ text: "base\n\ngate message\n\nfiring batch" }),
        );
      },
    );
  });

  it("passes a batch to a script payload without a gate and persists its state", async () => {
    const runScriptJob = vi.fn(async () => ({
      status: "ok" as const,
      stateChanged: true,
      state: { revision: 2 },
    }));
    await withStream(
      { payload: { kind: "script", script: "return {}" } },
      { runScriptJob },
      async (cron, job, storePath) => {
        await runBatch(cron, job, "script batch");
        expect((await loadCronStore(storePath)).jobs[0]?.state.triggerState).toEqual({
          revision: 2,
        });
        expect(runScriptJob).toHaveBeenCalledWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: job.id }),
            streamBatch: "script batch",
          }),
        );
      },
    );
  });

  it("reports a failed payload batch without reporting it fired or scheduling a context-free retry", async () => {
    const onTriggerDisposition = vi.fn();
    const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
      async () => undefined,
    );
    await withStream(
      {
        name: "failing stream payload",
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      },
      {
        cronConfig: {
          triggers: { enabled: true },
          failureAlert: { enabled: true, after: 1, cooldownMs: 0 },
        },
        runIsolatedAgentJob: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
        sendCronFailureAlert,
      },
      async (cron, job, storePath) => {
        await runBatch(cron, job, "failed batch", onTriggerDisposition);
        expect(onTriggerDisposition).toHaveBeenCalledExactlyOnceWith("error");
        expect(onTriggerDisposition).not.toHaveBeenCalledWith("fired");
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "error",
          lastError: "boom",
          consecutiveErrors: 1,
        });
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        const alert = sendCronFailureAlert.mock.calls[0]?.[0];
        expect(alert?.channel).toBe("telegram");
        expect(alert?.to).toBe("19098680");
        expect(alert?.payload).toEqual({
          text: 'Automation "failing stream payload" failed 1 times\nCheck automation history for details.',
        });
        expect(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.state
            .lastError,
        ).toBe("boom");
      },
    );
  });

  it("reports a skipped payload batch as a terminal drop", async () => {
    const onTriggerDisposition = vi.fn();
    await withStream(
      {},
      {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "skipped" as const,
          error: "runner unavailable",
        })),
      },
      async (cron, job) => {
        await runBatch(cron, job, "skipped batch", onTriggerDisposition);
        expect(onTriggerDisposition).toHaveBeenCalledWith("dropped");
        expect(cron.getJob(job.id)?.state).toMatchObject({ lastRunStatus: "skipped" });
      },
    );
  });
});
