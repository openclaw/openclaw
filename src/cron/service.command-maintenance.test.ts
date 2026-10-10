import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { runCronCommandJob } from "./command-runner.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { readCronRunRecordsForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-command-maintenance-",
  fakeTimers: false,
});

async function fixture() {
  const { storePath } = await makeStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  let now = Date.now();
  const runner = vi.fn(runCronCommandJob);
  const create = () =>
    new CronService({
      storePath,
      scheduler: createTestGatewayScheduler(),
      nowMs: () => now,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runCommandJob: runner,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
  const cron = create();
  const started = path.join(path.dirname(storePath), "started");
  const release = path.join(path.dirname(storePath), "release");
  const job = await cron.add({
    enabled: true,
    name: "Harmless command maintenance fixture",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "command",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.exit(23)}},10)",
        started,
        release,
      ],
      timeoutSeconds: 30,
    },
    delivery: { mode: "none" },
    failureAlert: false,
    failureRecovery: { agentId: "main", message: "Inspect this harmless fixture only." },
  });
  return {
    cron,
    create,
    job,
    storePath,
    runner,
    started,
    release,
    advance: () => {
      now += 3_600_000;
      return now;
    },
  };
}

describe("command maintenance disable", () => {
  it.each([false, true])(
    "preserves admitted execution only on explicit opt-in (%s)",
    async (preserveRunning) => {
      const box = await fixture();
      const running = box.cron.run(box.job.id, "force");
      try {
        await vi.waitFor(
          async () => expect(await fs.readFile(box.started, "utf8")).toBe("started"),
          { timeout: 10_000 },
        );
        const before = await box.cron.readJob(box.job.id);
        expect(before!.state.runningAtMs).toBeDefined();
        const originalReceiptId = (await loadCronStore(box.storePath)).jobs[0]?.state
          .runningReceiptId;
        expect(originalReceiptId).toEqual(expect.any(String));
        const signal = expectDefined(
          box.runner.mock.calls[0]?.[0].abortSignal,
          "actual command signal",
        );
        const disabled = await box.cron.update(
          box.job.id,
          { enabled: false },
          preserveRunning
            ? {
                preserveRunning: true,
                expectedConfigRevision: resolveCronJobConfigRevision(before!),
              }
            : undefined,
        );
        expect(disabled.enabled).toBe(false);
        expect(disabled.state.nextRunAtMs).toBeUndefined();
        expect(signal.aborted).toBe(!preserveRunning);
        await fs.writeFile(box.release, "release");
        await running;
        const records = readCronRunRecordsForTests(box.job.id);
        expect(records).toHaveLength(1);
        const record = expectDefined(records[0], "original terminal receipt");
        const originalRunId = expectDefined(record.runId, "original finished run");
        expect(originalRunId).toContain(originalReceiptId);
        if (preserveRunning) {
          expect(record.status).toBe("failed");
          expect(record.error).toContain("code 23");
          expect(signal.aborted).toBe(false);
        } else {
          expect(record.error).toContain("disabled by operator");
        }
        const current = await box.cron.readJob(box.job.id);
        expect(current).toMatchObject({ enabled: false, payload: box.job.payload });
        expect(current!.state.runningAtMs).toBeUndefined();
        expect(current!.state.nextRunAtMs).toBeUndefined();
        expect(current!.state.failureRecovery).toBeUndefined();
        expect((await loadCronStore(box.storePath)).jobs).toHaveLength(1);
        box.cron.stop();
        const restarted = box.create();
        try {
          await restarted.start();
          expect(readCronRunRecordsForTests(box.job.id)[0]?.runId).toBe(originalRunId);
          expect(await restarted.run(box.job.id, "if-enabled")).toMatchObject({ ran: false });
          expect(box.runner).toHaveBeenCalledOnce();
          const now = box.advance();
          const restored = await restarted.update(box.job.id, { enabled: true });
          expect(restored.state.nextRunAtMs).toBeGreaterThan(now);
          expect(box.runner).toHaveBeenCalledOnce();
        } finally {
          restarted.stop();
        }
      } finally {
        await fs.writeFile(box.release, "release");
        await running;
        box.cron.stop();
      }
    },
  );

  it("rejects missing/stale revisions, mixed patches and noncommands without mutation", async () => {
    const box = await fixture();
    try {
      const revision = resolveCronJobConfigRevision(box.job);
      for (const [patch, token] of [
        [{ enabled: false }, undefined],
        [{ enabled: false }, "stale"],
        [{ enabled: false, description: "mixed" }, revision],
        [{ enabled: true }, revision],
      ] as const) {
        await expect(
          box.cron.update(box.job.id, patch, {
            preserveRunning: true,
            expectedConfigRevision: token,
          }),
        ).rejects.toThrow("exact revision-checked command disable");
        expect((await loadCronStore(box.storePath)).jobs[0]).toEqual(box.job);
      }
      const changed = await box.cron.update(box.job.id, {
        failureRecovery: null,
        payload: { kind: "agentTurn", message: "No command" },
      });
      await expect(
        box.cron.update(
          box.job.id,
          { enabled: false },
          { preserveRunning: true, expectedConfigRevision: resolveCronJobConfigRevision(changed) },
        ),
      ).rejects.toThrow("exact revision-checked command disable");
      expect((await loadCronStore(box.storePath)).jobs[0]).toEqual(changed);
    } finally {
      box.cron.stop();
    }
  });

  it("fences a concurrent enabled-only admission on either side of the disable transaction", async () => {
    const box = await fixture();
    box.runner.mockImplementation(async () => ({ status: "ok" }));
    try {
      const [run, disabled] = await Promise.all([
        box.cron.run(box.job.id, "if-enabled"),
        box.cron.update(
          box.job.id,
          { enabled: false },
          { preserveRunning: true, expectedConfigRevision: resolveCronJobConfigRevision(box.job) },
        ),
      ]);
      expect(disabled.enabled).toBe(false);
      const ran = "ran" in run && run.ran;
      expect(box.runner.mock.calls.length).toBe(ran ? 1 : 0);
      expect(await box.cron.run(box.job.id, "if-enabled")).toMatchObject({ ran: false });
      expect((await box.cron.readJob(box.job.id))!.enabled).toBe(false);
      expect(box.runner.mock.calls.length).toBe(ran ? 1 : 0);
    } finally {
      box.cron.stop();
    }
  });

  it("retires a durably prepared queued occurrence before it can start after disable", async () => {
    const box = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      const queued = await box.cron.enqueueRun(box.job.id, "if-enabled");
      expect(queued).toMatchObject({ enqueued: true });
      expect((await box.cron.readJob(box.job.id))!.state.queuedAtMs).toBeDefined();
      const disabled = await box.cron.update(
        box.job.id,
        { enabled: false },
        {
          preserveRunning: true,
          expectedConfigRevision: resolveCronJobConfigRevision(box.job),
        },
      );
      expect(disabled.state.queuedAtMs).toBeUndefined();
      release.resolve();
      await blocker;
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
      expect(box.runner).not.toHaveBeenCalled();
      expect((await box.cron.readJob(box.job.id))!.enabled).toBe(false);
    } finally {
      release.resolve();
      await blocker;
      box.cron.stop();
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
      clearCommandLane(CommandLane.Cron);
    }
  });
});
