import { expect, it, vi } from "vitest";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createCronStreamWatcherFixture,
  exitResult,
  job,
} from "./cron-stream-watchers.test-helpers.js";

it("retains an exited host source whose process-tree cleanup is uncertain", async () => {
  vi.useFakeTimers();
  const { fake, watchers, recordFailure } = createCronStreamWatcherFixture();
  const streamJob = job();
  const observed = createDeferredCore();
  let confirmed = false;
  try {
    await watchers.start(streamJob);
    const run = fake.runs[0]!;
    run.waitForExtinction = async (): Promise<ProcessExtinctionResult> => {
      observed.resolve();
      return confirmed
        ? { status: "confirmed" }
        : { status: "uncertain", reason: "job-unavailable" };
    };
    fake.exits[0]!(exitResult());
    await observed.promise;
    // Joining the owner queue proves an exited root cannot admit a replacement.
    await expect(watchers.start(streamJob)).rejects.toThrow("job-unavailable");
    expect(watchers.inspect(streamJob.id)).toMatchObject({
      state: "stopping",
      processAlive: true,
      restartTimerPending: false,
    });
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledWith(
      streamJob.id,
      expect.stringContaining("job-unavailable"),
      expect.objectContaining({ streamStatus: "error", streamRestartExhausted: true }),
      expect.any(String),
      expect.any(String),
    );
    confirmed = true;
    await watchers.stop(streamJob.id, "disabled");
    expect(watchers.inspect(streamJob.id)).toMatchObject({ state: "stopped", processAlive: false });
  } finally {
    confirmed = true;
    await watchers.stopAll("shutdown");
    vi.useRealTimers();
  }
});
