import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import {
  createCronStreamWatcherFixture,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

it("joins host cleanup before reporting stopped or starting a replacement", async () => {
  const release = createDeferred();
  const fake = fakeSupervisor();
  fake.supervisor.acquireScopeCleanup.mockReturnValueOnce(vi.fn(async () => release.promise));
  const { watchers } = createCronStreamWatcherFixture({
    getProcessSupervisor: () => fake.supervisor,
  });
  try {
    await watchers.start(job());
    const stopping = watchers.stop("stream-job", "disabled");
    await settle();
    expect(watchers.inspect("stream-job")).toMatchObject({ state: "stopping" });
    const replacement = watchers.start(job());
    await settle();
    expect(fake.runs).toHaveLength(1);
    release.resolve();
    await Promise.all([stopping, replacement]);
    expect(fake.runs).toHaveLength(2);
    expect(watchers.inspect("stream-job")).toMatchObject({ state: "running" });
  } finally {
    release.resolve();
    await watchers.stopAll("shutdown");
  }
});

it("retains uncertain failed-start cleanup and refuses another source", async () => {
  const fake = fakeSupervisor();
  fake.spawn.mockRejectedValueOnce(new Error("fixture source launch failed"));
  fake.supervisor.acquireScopeCleanup.mockReturnValueOnce(
    vi.fn(async () => {
      throw new Error("fixture source extinction is unconfirmed");
    }),
  );
  const { watchers } = createCronStreamWatcherFixture({
    getProcessSupervisor: () => fake.supervisor,
  });
  try {
    await expect(watchers.start(job())).rejects.toThrow("extinction is unconfirmed");
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopping",
      processAlive: false,
      restartTimerPending: false,
    });
    await expect(watchers.start(job())).rejects.toThrow("extinction is unconfirmed");
    expect(fake.spawn).toHaveBeenCalledOnce();
    await expect(watchers.stop("stream-job", "disabled")).rejects.toThrow(
      "extinction is unconfirmed",
    );
    expect(watchers.inspect("stream-job")).toMatchObject({ state: "stopping" });
  } finally {
    await watchers.stopAll("shutdown").catch(() => {});
  }
});

it("rechecks host source authority after deferred native startup", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const fake = fakeSupervisor();
  const { watchers } = createCronStreamWatcherFixture({
    getProcessSupervisor: () => ({
      ...fake.supervisor,
      spawn: async (input: SpawnInput) => {
        entered.resolve();
        await release.promise;
        input.assertCurrent?.();
        return await fake.spawn(input);
      },
    }),
  });
  try {
    const starting = watchers.start(job());
    await entered.promise;
    const stopping = watchers.stop("stream-job", "disabled");
    release.resolve();
    await Promise.all([starting, stopping]);
    expect(fake.runs).toHaveLength(0);
    expect(watchers.inspect("stream-job")).toMatchObject({ state: "stopped" });
  } finally {
    release.resolve();
    await watchers.stopAll("shutdown");
  }
});

it.each(["identical", "updated"])(
  "admits only the latest %s request after deferred source preparation",
  async (variant) => {
    const entered = createDeferred();
    const release = createDeferred();
    const fake = fakeSupervisor();
    const { watchers, recordFailure } = createCronStreamWatcherFixture({
      getProcessSupervisor: () => ({
        ...fake.supervisor,
        spawn: async (input: SpawnInput) => {
          entered.resolve();
          await release.promise;
          input.assertCurrent?.();
          return await fake.spawn(input);
        },
      }),
    });
    const command = variant === "updated" ? ["replacement"] : ["stream-source"];
    try {
      const starting = watchers.start(job());
      await entered.promise;
      const replacement = watchers.start(
        job({ schedule: { kind: "stream", command, batchMs: 50 } }),
      );
      release.resolve();
      await Promise.all([starting, replacement]);
      expect(fake.inputs.map((input) => (input.mode === "child" ? input.argv : undefined))).toEqual(
        [command],
      );
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        consecutiveFailures: 0,
        restartTimerPending: false,
      });
      expect(recordFailure).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await watchers.stopAll("shutdown");
    }
  },
);

it("keeps a running source current across repeated starts and reconciliation", async () => {
  const { fake, watchers } = createCronStreamWatcherFixture();
  const streamJob = job();
  try {
    await watchers.start(streamJob);
    const assertCurrent = fake.inputs[0]?.assertCurrent;
    expect(assertCurrent).toBeTypeOf("function");
    await watchers.start(streamJob);
    await watchers.reconcile([streamJob], true);
    expect(assertCurrent).not.toThrow();
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(fake.runs[0]?.cancel).not.toHaveBeenCalled();

    const stopping = watchers.stop(streamJob.id, "disabled");
    expect(assertCurrent).toThrow("Stream source admission is no longer current");
    await stopping;
  } finally {
    await watchers.stopAll("shutdown");
  }
});

it("does not revive a running source after a superseded replacement", async () => {
  const { fake, watchers, recordFailure } = createCronStreamWatcherFixture();
  const original = job();
  try {
    await watchers.start(original);
    const assertOriginalCurrent = fake.inputs[0]?.assertCurrent;
    expect(assertOriginalCurrent).toBeTypeOf("function");
    const replacement = watchers.start(
      job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
    );
    const reverted = watchers.start(original);
    // Both watcher calls admit their requests before the serialized owner operations run.
    await Promise.resolve();
    expect(assertOriginalCurrent).toThrow("Stream source admission is no longer current");
    await Promise.all([replacement, reverted]);

    expect(fake.inputs.map((input) => (input.mode === "child" ? input.argv : undefined))).toEqual([
      ["stream-source"],
      ["stream-source"],
    ]);
    expect(fake.runs[0]?.cancel).toHaveBeenCalled();
    expect(assertOriginalCurrent).toThrow("Stream source admission is no longer current");
    expect(fake.inputs[1]?.assertCurrent).toBeTypeOf("function");
    expect(fake.inputs[1]?.assertCurrent).not.toThrow();
    expect(watchers.inspect(original.id)).toMatchObject({
      state: "running",
      consecutiveFailures: 0,
      restartTimerPending: false,
    });
    expect(recordFailure).not.toHaveBeenCalled();
  } finally {
    await watchers.stopAll("shutdown");
  }
});
