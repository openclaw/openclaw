import { expect, it, vi } from "vitest";
import { makeCronStreamSandboxTarget } from "../cron/stream-sandbox.test-support.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { CronStreamOwnerParams } from "./cron-stream-owner-types.js";
import {
  createCronStreamWatcherFixture,
  exitResult,
  job,
} from "./cron-stream-watchers.test-helpers.js";

function sandboxJob(): CronStoredJob {
  return { ...job(), streamSandbox: makeCronStreamSandboxTarget() };
}

it("delivers split UTF-8 sandbox output through the watcher without starting a host process", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const exited = createDeferredCore<ReturnType<typeof exitResult>>();
  const delivered = createDeferredCore<string>();
  const spawnSandboxSource = vi.fn<NonNullable<CronStreamOwnerParams["spawnSandboxSource"]>>(
    async ({ assertCurrent, onOutput }) => {
      assertCurrent();
      const bytes = Buffer.from("watcher 🦀 ready\n");
      onOutput("stdout", bytes.subarray(0, 10));
      onOutput("stdout", bytes.subarray(10));
      return {
        activity: { resultSettled: false, lastOutputAtMs: 0 },
        runId: "sandbox-watcher",
        startedAtMs: 0,
        stdin: undefined,
        cancel: () => exited.resolve(exitResult({ reason: "manual-cancel" })),
        wait: () => exited.promise,
        waitForExtinction: async () => {
          await exited.promise;
        },
      };
    },
  );
  const { fake, watchers } = createCronStreamWatcherFixture({
    scheduler,
    spawnSandboxSource,
    minIntervalMs: 1,
    fireBatch: vi.fn(async (_job: CronJob, batch: string) => {
      delivered.resolve(batch);
      return "fired" as const;
    }),
  });
  try {
    await watchers.start(sandboxJob());
    await clock.advanceBy(50);
    expect(await delivered.promise).toBe("watcher 🦀 ready");
    expect(spawnSandboxSource).toHaveBeenCalledOnce();
    expect(fake.spawn).not.toHaveBeenCalled();
  } finally {
    await watchers.stopAll("shutdown");
    await scheduler.stop();
  }
});

it("records unavailable sandbox execution without falling back to the host", async () => {
  const { fake, watchers, updateState } = createCronStreamWatcherFixture();
  try {
    await watchers.start(sandboxJob());
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({
        streamStatus: "restarting",
        streamError: expect.stringContaining("Sandbox stream execution is unavailable"),
      }),
      expect.any(String),
      expect.any(String),
    );
  } finally {
    await watchers.stopAll("shutdown");
  }
});

it("retains failed sandbox extinction, reports the error, and blocks replacement", async () => {
  const scheduler = createTestGatewayScheduler();
  const failed = createDeferredCore<ReturnType<typeof exitResult>>();
  const extinctionAttempted = createDeferredCore();
  const extinctionError = new Error("sandbox helper disappeared; process custody is uncertain");
  let extinctionConfirmed = false;
  const spawnSandboxSource = vi.fn<NonNullable<CronStreamOwnerParams["spawnSandboxSource"]>>(
    async () => ({
      activity: { resultSettled: false, lastOutputAtMs: 0 },
      runId: "uncertain-sandbox-watcher",
      startedAtMs: 0,
      cancel: () => {},
      wait: () => failed.promise,
      waitForExtinction: async () => {
        extinctionAttempted.resolve();
        if (!extinctionConfirmed) {
          throw extinctionError;
        }
      },
    }),
  );
  const { watchers, recordFailure, fake } = createCronStreamWatcherFixture({
    scheduler,
    spawnSandboxSource,
  });
  const streamJob = sandboxJob();
  try {
    await watchers.start(streamJob);
    failed.reject(new Error("sandbox transport failed"));
    await extinctionAttempted.promise;
    // This start joins exit handling through the actual owner queue.
    await expect(watchers.start(streamJob)).rejects.toThrow(extinctionError.message);
    expect(watchers.inspect(streamJob.id)).toMatchObject({
      state: "stopping",
      processAlive: true,
      restartTimerPending: false,
    });
    expect(recordFailure).toHaveBeenCalledWith(
      streamJob.id,
      expect.stringContaining(extinctionError.message),
      expect.objectContaining({
        streamStatus: "error",
        streamError: expect.stringContaining(extinctionError.message),
        streamRestartExhausted: true,
      }),
      expect.any(String),
      expect.any(String),
    );
    expect(spawnSandboxSource).toHaveBeenCalledOnce();
    expect(fake.spawn).not.toHaveBeenCalled();
  } finally {
    extinctionConfirmed = true;
    await watchers.stopAll("shutdown");
    await scheduler.stop();
  }
});
