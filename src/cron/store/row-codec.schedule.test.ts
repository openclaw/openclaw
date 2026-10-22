import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { makeCronStreamSandboxTarget } from "../stream-sandbox.test-support.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec, rowToCronJob } from "./row-codec.js";

describe("canonical cron schedule JSON round-trip", () => {
  it.each([
    { name: "missing target", target: undefined },
    { name: "unsupported backend", target: { ...makeCronStreamSandboxTarget(), backendId: "ssh" } },
    {
      name: "missing session identity",
      target: { ...makeCronStreamSandboxTarget(), sessionId: "" },
    },
    {
      name: "missing grant observation",
      target: {
        ...makeCronStreamSandboxTarget(),
        operator: { profileId: "profile-ada", scopes: ["operator.write"], assignedRole: null },
      },
    },
    {
      name: "malformed grant",
      target: {
        ...makeCronStreamSandboxTarget(),
        operator: {
          profileId: "profile-ada",
          scopes: ["operator.write"],
          assignedRole: null,
          gatewayAccessGrant: {},
        },
      },
    },
  ])("rejects a persisted sandbox stream with $name", ({ target }) => {
    const job = makeCronJob({});
    expect(
      rowToCronJob(
        { job_id: job.id, state_json: "{}", updated_at: 1, runtime_updated_at_ms: 1 },
        {
          ...job,
          schedule: { kind: "sandbox-stream", command: ["watch-source"] },
          streamSandbox: target,
        },
      ),
    ).toBeNull();
  });

  it("requires the persisted sandbox discriminator and preserves the private target", () => {
    const streamSandbox = makeCronStreamSandboxTarget();
    const job = {
      ...makeCronJob({ schedule: { kind: "stream", command: ["watch-source"] } }),
      streamSandbox,
    };
    const row = { job_id: job.id, state_json: "{}", updated_at: 1, runtime_updated_at_ms: 1 };
    expect(rowToCronJob(row, job)).toBeNull();
    expect(
      rowToCronJob(row, { ...job, schedule: { ...job.schedule, kind: "sandbox-stream" } }),
    ).toMatchObject({ schedule: job.schedule, streamSandbox });
    const projected = projectCronJobThroughStorageCodec(job);
    expect(projected.streamSandbox).toEqual(streamSandbox);
    expect(projected.streamSandbox).not.toBe(streamSandbox);
    expect(projected.streamSandbox?.operator?.scopes).not.toBe(streamSandbox.operator?.scopes);
  });

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
});
