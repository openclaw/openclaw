import { describe, expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { toPublicCronJob } from "./public-job.js";

describe("toPublicCronJob", () => {
  it("strips scheduler-only pacing slots without mutating stored state", () => {
    const job = makeCronJob({
      state: {
        instanceId: "private-instance",
        scheduleRevision: 2,
        stateRevision: 3,
        triggerRevision: 4,
        activeRunInstanceIdentity: "private-run-instance",
        activeRunScheduleIdentity: "private-run-schedule",
        activeRunScheduleMode: "preserve",
        activeRunStateIdentity: "private-run-state",
        nextRunAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
        forcePreservedNextRunAtMs: 2_000,
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.state.pacedNextRunAtMs).toBeUndefined();
    expect(publicJob.state.instanceId).toBeUndefined();
    expect(publicJob.state.forcePreservedNextRunAtMs).toBeUndefined();
    expect(publicJob.state.scheduleRevision).toBeUndefined();
    expect(publicJob.state.stateRevision).toBeUndefined();
    expect(publicJob.state.triggerRevision).toBeUndefined();
    expect(publicJob.state.activeRunInstanceIdentity).toBeUndefined();
    expect(publicJob.state.activeRunScheduleIdentity).toBeUndefined();
    expect(publicJob.state.activeRunScheduleMode).toBeUndefined();
    expect(publicJob.state.activeRunStateIdentity).toBeUndefined();
    expect(job.state.pacedNextRunAtMs).toBe(2_000);
    expect(job.state.instanceId).toBe("private-instance");
    expect(job.state.forcePreservedNextRunAtMs).toBe(2_000);
    expect(job.state.scheduleRevision).toBe(2);
    expect(job.state.stateRevision).toBe(3);
    expect(job.state.triggerRevision).toBe(4);
  });

  it("projects script payload fields without exposing scheduler-only state", () => {
    const job = makeCronJob({
      sessionTarget: "isolated",
      payload: {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 300,
        toolBudget: 50,
      },
      state: { triggerState: { revision: 1 }, pacedNextRunAtMs: 2_000 },
    });

    expect(toPublicCronJob(job)).toMatchObject({
      payload: {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 300,
        toolBudget: 50,
      },
      state: { triggerState: { revision: 1 } },
    });
  });
});
