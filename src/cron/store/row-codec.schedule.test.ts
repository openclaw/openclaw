import { expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import * as normalization from "../normalize.js";
import { makeCronStreamSandboxTarget } from "../stream-sandbox.test-support.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec as project, rowToCronJob } from "./row-codec.js";

const stream = { kind: "stream", command: ["watch-source"] } as const;
const operator = { profileId: "profile-ada", scopes: ["operator.write"], assignedRole: null };
const target = makeCronStreamSandboxTarget();

it("normalizes the isolated clone without copying its envelope again", () => {
  const job = makeCronJob({});
  const clone = vi.spyOn(globalThis, "structuredClone");
  const normalize = vi.spyOn(normalization, "normalizeCronJobInput");
  try {
    const projected = project(job);
    expect(normalize.mock.calls[0]?.[0]).toBe(clone.mock.results[0]?.value);
    expect(normalize.mock.calls[0]?.[0]).not.toBe(job);
    expect(projected.schedule).toEqual(job.schedule);
    expect(projected.schedule).not.toBe(job.schedule);
  } finally {
    normalize.mockRestore();
    clone.mockRestore();
  }
});
function decode(job: Record<string, unknown> & { id: string }) {
  return rowToCronJob(
    { job_id: job.id, state_json: "{}", updated_at: 1, runtime_updated_at_ms: 1 },
    job,
  );
}

it.each([
  ["missing target", undefined],
  ["unsupported backend", { ...target, backendId: "ssh" }],
  ["missing session identity", { ...target, sessionId: "" }],
  ["missing grant observation", { ...target, operator }],
  ["malformed grant", { ...target, operator: { ...operator, gatewayAccessGrant: {} } }],
])("rejects a persisted sandbox stream with %s", (_, streamSandbox) => {
  expect(
    decode({ ...makeCronJob({}), schedule: { ...stream, kind: "sandbox-stream" }, streamSandbox }),
  ).toBeNull();
});

it("requires the persisted sandbox discriminator and preserves the private target", () => {
  const streamSandbox = makeCronStreamSandboxTarget();
  const job = {
    ...makeCronJob({ schedule: { ...stream, command: [...stream.command] } }),
    streamSandbox,
  };
  expect(decode(job)).toBeNull();
  expect(decode({ ...job, schedule: { ...job.schedule, kind: "sandbox-stream" } })).toMatchObject({
    schedule: job.schedule,
    streamSandbox,
  });
  const projected = project(job);
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
  const job = project({
    ...makeCronJob({}),
    runtimeAuthority,
    runtimeAuthorityRecoveryRequired: true,
  });
  expect(job.runtimeAuthority).toBeUndefined();
  expect(job.runtimeAuthorityRecoveryRequired).toBeUndefined();

  const malformed = project({
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
  const projected = project(input);

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
