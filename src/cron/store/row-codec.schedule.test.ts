import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec, rowToCronJob } from "./row-codec.js";

describe("canonical cron schedule JSON round-trip", () => {
  it("keeps private runtime authority out of job_json", () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority,
      runtimeAuthorityRecoveryRequired: true,
    });
    expect(job.runtimeAuthority).toBeUndefined();
    expect(job.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const malformed = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority: { ...runtimeAuthority, version: 2 } as never,
    });
    expect(malformed.runtimeAuthority).toBeUndefined();
  });

  it("round-trips a paced stream without aliasing input config or runtime state", () => {
    const schedule: CronSchedule = {
      kind: "stream",
      command: ["node", "events.mjs"],
      cwd: "/repo",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2_048,
    };
    const triggerState = { cursor: { position: 7 }, items: ["first"] };
    const input = makeCronJob({
      schedule,
      pacing: { min: "15m", max: "4h" },
      state: { lastStatus: "ok", triggerState, nextRunAtMs: 123_000 },
    });
    const before = structuredClone(input);
    const projected = projectCronJobThroughStorageCodec(input);

    expect(projected.schedule).toStrictEqual(schedule);
    expect(projected.pacing).toStrictEqual(input.pacing);
    expect(projected.state).toStrictEqual({ ...input.state, lastRunStatus: "ok" });
    expect(input).toStrictEqual(before);
    expect(Object.is(projected.schedule, input.schedule)).toBe(false);
    expect(Object.is(projected.pacing, input.pacing)).toBe(false);
    expect(Object.is(projected.state, input.state)).toBe(false);
    expect(Object.is(projected.state.triggerState, triggerState)).toBe(false);
    triggerState.cursor.position = 9;
    triggerState.items.push("second");
    expect(projected.state.triggerState).toStrictEqual({
      cursor: { position: 7 },
      items: ["first"],
    });
  });

  it.each([
    { activeHours: { start: "24:00", end: "08:00" } },
    { activeHours: { start: "08:00", end: "24:00", timezone: "invalid/timezone" } },
    { activeHours: { start: "08:00" } },
    { idleOnly: "false" },
    { payload: { kind: "agentTurn", message: "check", includeReasoning: "false" } },
    { payload: { kind: "agentTurn", message: "check", skipIfScratchEmpty: "false" } },
  ])(
    "refuses stored execution policy that would change behavior through coercion: %j",
    (policy) => {
      const job = makeCronJob({});
      expect(
        rowToCronJob(
          { job_id: job.id, state_json: "{}", updated_at: 1, runtime_updated_at_ms: 1 },
          { ...job, ...policy },
        ),
      ).toBeNull();
    },
  );
});
