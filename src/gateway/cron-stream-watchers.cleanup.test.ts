import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import {
  createCronStreamWatcherFixture,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

function cleanup(
  watchers: ReturnType<typeof createCronStreamWatcherFixture>["watchers"],
  release = () => {},
) {
  onTestFinished(async () => {
    release();
    await watchers.stopAll("shutdown");
  });
}

function expectHealthy(watchers: ReturnType<typeof createCronStreamWatcherFixture>["watchers"]) {
  expect(watchers.inspect("stream-job")).toMatchObject({
    state: "running",
    consecutiveFailures: 0,
    restartTimerPending: false,
  });
}

const commands = (fake: ReturnType<typeof fakeSupervisor>) =>
  fake.inputs.map((input) => (input.mode === "child" ? input.argv : undefined));

function deferredSourceFixture() {
  const entered = createDeferred();
  const release = createDeferred();
  const fake = fakeSupervisor();
  const fixture = createCronStreamWatcherFixture({
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
  cleanup(fixture.watchers, release.resolve);
  return { ...fixture, fake, entered: entered.promise, release: release.resolve };
}

it("joins host cleanup before reporting stopped or starting a replacement", async () => {
  const release = createDeferred();
  const fake = fakeSupervisor();
  fake.supervisor.acquireScopeCleanup.mockReturnValueOnce(vi.fn(async () => release.promise));
  const { watchers } = createCronStreamWatcherFixture({
    getProcessSupervisor: () => fake.supervisor,
  });
  cleanup(watchers, release.resolve);
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
  onTestFinished(() => watchers.stopAll("shutdown").catch(() => {}));
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
});

it("rechecks host source authority after deferred native startup", async () => {
  const { fake, watchers, entered, release } = deferredSourceFixture();
  const starting = watchers.start(job());
  await entered;
  const stopping = watchers.stop("stream-job", "disabled");
  release();
  await Promise.all([starting, stopping]);
  expect(fake.runs).toHaveLength(0);
  expect(watchers.inspect("stream-job")).toMatchObject({ state: "stopped" });
});

it.each(["identical", "updated"])(
  "admits only the latest %s request after deferred source preparation",
  async (variant) => {
    const { fake, watchers, recordFailure, entered, release } = deferredSourceFixture();
    const command = variant === "updated" ? ["replacement"] : ["stream-source"];
    const starting = watchers.start(job());
    await entered;
    const replacement = watchers.start(job({ schedule: { kind: "stream", command, batchMs: 50 } }));
    release();
    await Promise.all([starting, replacement]);
    expect(commands(fake)).toEqual([command]);
    expectHealthy(watchers);
    expect(recordFailure).not.toHaveBeenCalled();
  },
);

it("keeps a running source current across repeated starts and reconciliation", async () => {
  const { fake, watchers } = createCronStreamWatcherFixture();
  cleanup(watchers);
  const streamJob = job();
  await watchers.start(streamJob);
  const assertCurrent = fake.inputs[0]?.assertCurrent;
  await watchers.start(streamJob);
  await watchers.reconcile([streamJob], true);
  expect(assertCurrent).not.toThrow();
  expect(fake.spawn).toHaveBeenCalledOnce();
  expect(fake.runs[0]?.cancel).not.toHaveBeenCalled();

  const stopping = watchers.stop(streamJob.id, "disabled");
  expect(assertCurrent).toThrow("Stream source admission is no longer current");
  await stopping;
});

it("does not revive a running source after a superseded replacement", async () => {
  const { fake, watchers, recordFailure } = createCronStreamWatcherFixture();
  cleanup(watchers);
  const original = job();
  await watchers.start(original);
  const assertOriginalCurrent = fake.inputs[0]?.assertCurrent;
  const replacement = watchers.start(
    job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
  );
  const reverted = watchers.start(original);
  await Promise.resolve();
  expect(assertOriginalCurrent).toThrow("Stream source admission is no longer current");
  await Promise.all([replacement, reverted]);

  expect(commands(fake)).toEqual([["stream-source"], ["stream-source"]]);
  expect(fake.runs[0]?.cancel).toHaveBeenCalled();
  expect(assertOriginalCurrent).toThrow("Stream source admission is no longer current");
  expect(fake.inputs[1]?.assertCurrent).not.toThrow();
  expectHealthy(watchers);
  expect(recordFailure).not.toHaveBeenCalled();
});
