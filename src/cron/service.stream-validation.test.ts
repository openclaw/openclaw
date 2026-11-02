import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { makeCronStreamSandboxTarget } from "./stream-sandbox.test-support.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob, CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-stream-validation-" });

function streamJob(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "stream",
    enabled: true,
    schedule: { kind: "stream", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "handle events" },
    ...overrides,
  };
}

async function createCron(triggersEnabled: boolean, deps: Partial<CronServiceDeps> = {}) {
  const storePath = deps.storePath ?? (await makeStorePath()).storePath;
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: triggersEnabled } },
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
  await cron.start();
  return { cron, storePath };
}

describe("cron stream schedule validation", () => {
  it("rejects creation while cron triggers are disabled", async () => {
    const { cron } = await createCron(false);
    try {
      await expect(cron.add(streamJob())).rejects.toThrow(
        "the operator set cron.triggers.enabled: false",
      );
    } finally {
      cron.stop();
    }
  });

  it("validates match regexes and command payload ambiguity", async () => {
    const { cron } = await createCron(true);
    try {
      for (const [schedule, error] of [
        [{ mode: "match" }, "match is required"],
        [{ mode: "match", match: "^(a+)+$" }, "unsafe-nested-repetition"],
        [{ match: "^ready" }, 'match requires mode="match"'],
      ] as const) {
        await expect(
          cron.add(streamJob({ schedule: { kind: "stream", command: ["echo"], ...schedule } })),
        ).rejects.toThrow(error);
      }
      await expect(
        cron.add(
          streamJob({
            payload: { kind: "command", argv: ["echo", "payload"] },
          }),
        ),
      ).rejects.toThrow("cannot use command payloads");
    } finally {
      cron.stop();
    }
  });

  it("clamps explicit batch bounds during normalization", async () => {
    const { cron } = await createCron(true);
    try {
      const job = await cron.add(
        streamJob({
          schedule: {
            kind: "stream",
            command: ["echo"],
            batchMs: 1,
            maxBatchBytes: 999_999,
          },
        }),
      );
      expect(job.schedule).toMatchObject({ batchMs: 50, maxBatchBytes: 65_536 });
      await expect(
        cron.add(
          streamJob({
            schedule: { kind: "stream", command: ["echo"], batchMs: 1.5 },
          }),
        ),
      ).rejects.toThrow("batching values must be integers");
    } finally {
      cron.stop();
    }
  });

  it.each(["gateway", "sandbox"] as const)(
    "rotates %s logical source identity only when source ownership changes",
    async (host) => {
      const { cron } = await createCron(true);
      const streamSandbox = host === "sandbox" ? makeCronStreamSandboxTarget() : undefined;
      try {
        const created = await cron.add(streamJob(), { streamSandbox });
        const initialIdentity = created.state.streamSourceIdentity;
        expect(initialIdentity).toEqual(expect.any(String));

        const equivalent = await cron.update(created.id, {
          schedule: structuredClone(created.schedule),
        });
        expect(equivalent.state.streamSourceIdentity).toBe(initialIdentity);

        const enabled = await cron.update(created.id, {
          enabled: true,
          state: { streamRestartExhausted: true },
        });
        expect(enabled.state.streamRestartExhausted).toBeUndefined();
        expect(enabled.state.streamSourceIdentity).toBe(initialIdentity);

        const exhausted = await cron.update(created.id, {
          state: { streamRestartExhausted: true },
        });
        const assertedAgain = await cron.update(created.id, {
          state: { streamRestartExhausted: true },
        });
        const exhaustedIdentity = exhausted.state.streamSourceIdentity;
        if (exhausted.schedule.kind !== "stream" || !exhaustedIdentity) {
          throw new Error("expected exhausted stream source identity");
        }
        expect(exhaustedIdentity).not.toBe(initialIdentity);
        expect(assertedAgain.state.streamSourceIdentity).not.toBe(exhaustedIdentity);
        await expect(
          cron.updateExternalState(
            created.id,
            cronStreamScheduleKey(exhausted.schedule, streamSandbox),
            exhaustedIdentity,
            { streamRestartExhausted: undefined },
          ),
        ).resolves.toBe(false);
        expect((await cron.readJob(created.id))?.state.streamRestartExhausted).toBe(true);

        const replaced = await cron.update(created.id, {
          schedule: { kind: "stream", command: ["replacement-source"] },
        });
        expect(replaced.state.streamSourceIdentity).not.toBe(initialIdentity);

        const disabled = await cron.update(created.id, { enabled: false });
        expect(disabled.state.streamSourceIdentity).not.toBe(replaced.state.streamSourceIdentity);

        const reenabled = await cron.update(created.id, { enabled: true });
        expect(reenabled.state.streamSourceIdentity).not.toBe(disabled.state.streamSourceIdentity);
        if (streamSandbox) {
          if (reenabled.schedule.kind !== "stream") {
            throw new Error("expected stream schedule");
          }
          expect(reenabled).toHaveProperty("streamSandbox", streamSandbox);
          const replacement = { ...streamSandbox, sessionId: "replacement-creator" };
          const retargeted = await cron.update(created.id, {}, { streamSandbox: replacement });
          const identity = retargeted.state.streamSourceIdentity;
          if (!identity) {
            throw new Error("expected replacement stream identity");
          }
          expect(identity).not.toBe(reenabled.state.streamSourceIdentity);
          await expect(
            cron.updateExternalState(
              created.id,
              cronStreamScheduleKey(reenabled.schedule, streamSandbox),
              identity,
              { streamStatus: "stopped" },
            ),
          ).resolves.toBe(false);
          await expect(
            cron.updateExternalState(
              created.id,
              cronStreamScheduleKey(reenabled.schedule, replacement),
              identity,
              { streamStatus: "stopped" },
            ),
          ).resolves.toBe(true);
          const timer = await cron.update(created.id, {
            schedule: { kind: "every", everyMs: 60_000 },
          });
          expect(timer).not.toHaveProperty("streamSandbox");
          expect(timer.state.streamSourceIdentity).toBeUndefined();
        }
      } finally {
        cron.stop();
      }
    },
  );

  it("ignores stale owner writes after an A-to-B-to-A source replacement", async () => {
    const { cron } = await createCron(true);
    try {
      const created = await cron.add(streamJob());
      if (created.schedule.kind !== "stream") {
        throw new Error("expected stream schedule");
      }
      const oldSchedule = structuredClone(created.schedule);
      const oldScheduleKey = cronStreamScheduleKey(oldSchedule);
      const oldSourceIdentity = created.state.streamSourceIdentity;
      if (!oldSourceIdentity) {
        throw new Error("expected stream source identity");
      }
      await cron.update(created.id, {
        schedule: { kind: "stream", command: ["replacement-source"] },
      });
      const restored = await cron.update(created.id, { schedule: oldSchedule });
      if (restored.schedule.kind !== "stream") {
        throw new Error("expected restored stream schedule");
      }
      expect(cronStreamScheduleKey(restored.schedule)).toBe(oldScheduleKey);
      expect(restored.state.streamSourceIdentity).not.toBe(oldSourceIdentity);

      await expect(
        cron.updateExternalState(created.id, oldScheduleKey, oldSourceIdentity, {
          streamStatus: "stopped",
        }),
      ).resolves.toBe(false);
      await cron.updateExternalCounters(created.id, {
        streamDroppedBatches: 1,
        streamCoalescedBatches: 0,
      });
      await cron.recordExternalFailure(
        created.id,
        "stale source failure",
        {
          streamStatus: "error",
          streamRestartExhausted: true,
        },
        { scheduleKey: oldScheduleKey, identity: oldSourceIdentity },
      );

      expect(cron.getJob(created.id)?.state).not.toMatchObject({
        streamStatus: "error",
        streamRestartExhausted: true,
      });
      expect(cron.getJob(created.id)?.state.streamDroppedBatches).toBe(1);
    } finally {
      cron.stop();
    }
  });
});

async function withStream(
  input: Partial<CronJobCreate>,
  deps: Partial<CronServiceDeps>,
  run: (cron: CronService, job: CronJob, storePath: string) => Promise<void>,
) {
  const { cron, storePath } = await createCron(true, deps);
  try {
    const job = await cron.add(
      streamJob({
        schedule: { kind: "stream", command: ["echo"] },
        payload: { kind: "agentTurn", message: "base" },
        ...input,
      }),
    );
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

it("skips invalid main jobs with command payloads loaded from disk", async () => {
  const { storePath } = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>();
  await writeCronStoreSnapshot({
    storePath,
    jobs: [
      {
        id: "job-1",
        name: "bad",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "command", argv: ["echo", "invalid main payload"] },
        state: {},
      },
    ],
  });
  const { cron } = await createCron(true, {
    storePath,
    cronConfig: undefined,
    enqueueSystemEvent,
    runCommandJob,
    runSessionEvent,
  });
  try {
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(runSessionEvent).not.toHaveBeenCalled();
    const [job] = await cron.list({ includeDisabled: true });
    expect(job?.state.lastStatus).toBe("skipped");
    expect(job?.state.lastError).toMatch(/sessionTarget "main" requires payload\.kind/i);
  } finally {
    cron.stop();
  }
});
