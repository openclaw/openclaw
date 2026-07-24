import { describe, expect, expectTypeOf, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { redactCronJsonReadback, toPublicCronJob } from "./public-job.js";
import type { CronJobCreate } from "./types.js";

describe("toPublicCronJob", () => {
  it("strips scheduler-only pacing slots without mutating stored state", () => {
    const job = makeCronJob({
      state: {
        nextRunAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
        forcePreservedNextRunAtMs: 2_000,
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.state.pacedNextRunAtMs).toBeUndefined();
    expect(publicJob.state.forcePreservedNextRunAtMs).toBeUndefined();
    expect(job.state.pacedNextRunAtMs).toBe(2_000);
    expect(job.state.forcePreservedNextRunAtMs).toBe(2_000);
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

  it("redacts command env values without mutating the stored job", () => {
    const marker = "cron-public-job-secret-marker";
    const job = makeCronJob({
      payload: {
        kind: "command",
        argv: ["deploy"],
        env: { API_TOKEN: marker, EMPTY: "" },
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.payload).toMatchObject({
      kind: "command",
      env: { API_TOKEN: "[redacted]", EMPTY: "[redacted]" },
    });
    expect(JSON.stringify(publicJob)).not.toContain(marker);
    expect(job.payload).toMatchObject({ env: { API_TOKEN: marker, EMPTY: "" } });
    expectTypeOf(publicJob).not.toMatchTypeOf<CronJobCreate>();
  });

  it("redacts nested command payloads in alternative JSON envelopes", () => {
    const marker = "cron-nested-secret-marker";
    const input = {
      result: {
        jobs: [
          {
            wrapper: {
              payload: {
                kind: "command",
                argv: ["deploy"],
                env: { DEPLOY_KEY: marker },
              },
            },
          },
        ],
      },
    };

    const readback = redactCronJsonReadback(input);

    expect(readback.result.jobs[0]?.wrapper.payload.env).toEqual({
      DEPLOY_KEY: "[redacted]",
    });
    expect(JSON.stringify(readback)).not.toContain(marker);
    expect(input.result.jobs[0]?.wrapper.payload.env.DEPLOY_KEY).toBe(marker);
  });
});
