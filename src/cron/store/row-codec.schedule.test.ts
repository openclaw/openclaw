import { expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { makeCronStreamSandboxTarget } from "../stream-sandbox.test-support.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec as project, rowToCronJob } from "./row-codec.js";

const stream: CronSchedule = {
  kind: "stream",
  command: ["node", "events.mjs"],
  cwd: "/repo",
  mode: "match",
  match: "^ready:",
  batchMs: 100,
  maxBatchBytes: 2_048,
};
const operator = { profileId: "profile-ada", scopes: ["operator.write"], assignedRole: null };
const target = makeCronStreamSandboxTarget();

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
  const job = { ...makeCronJob({ schedule: structuredClone(stream) }), streamSandbox: target };
  expect(decode(job)).toBeNull();
  expect(decode({ ...job, schedule: { ...job.schedule, kind: "sandbox-stream" } })).toMatchObject({
    schedule: job.schedule,
    streamSandbox: target,
  });
  const projected = project(job);
  expect(projected.streamSandbox).toEqual(target);
  expect(projected.streamSandbox).not.toBe(target);
  expect(projected.streamSandbox?.operator?.scopes).not.toBe(target.operator?.scopes);
});

it("round-trips a paced stream without aliasing input config or runtime state", () => {
  const triggerState = { cursor: { position: 7 }, items: ["first"] };
  const input = makeCronJob({
    schedule: structuredClone(stream),
    pacing: { min: "15m", max: "4h" },
    state: { lastStatus: "ok", triggerState, nextRunAtMs: 123_000 },
  });
  const before = structuredClone(input);
  const projected = project(input);

  expect(projected.schedule).toStrictEqual(stream);
  expect(projected.pacing).toStrictEqual(input.pacing);
  expect(projected.state).toStrictEqual({ ...input.state, lastRunStatus: "ok" });
  expect(input).toStrictEqual(before);
  expect(Object.is(projected.schedule, input.schedule)).toBe(false);
  expect(Object.is(projected.pacing, input.pacing)).toBe(false);
  expect(Object.is(projected.state, input.state)).toBe(false);
  expect(Object.is(projected.state.triggerState, triggerState)).toBe(false);
  triggerState.cursor.position = 9;
  triggerState.items.push("second");
  expect(projected.state.triggerState).toStrictEqual(before.state.triggerState);
});
