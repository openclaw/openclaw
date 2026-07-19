import { describe, expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { toPublicCronJob } from "./public-job.js";

describe("toPublicCronJob", () => {
  it("strips scheduler-only pacing slots without mutating stored state", () => {
    const job = makeCronJob({
      state: {
        nextRunAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.state.pacedNextRunAtMs).toBeUndefined();
    expect(job.state.pacedNextRunAtMs).toBe(2_000);
  });
});
