import { expect, it } from "vitest";
import { isReadRequest } from "./openclaw-state-read.validation.js";

it("keeps channel identity reads closed and bounds every identity component", () => {
  const valid = { channelId: "channel", accountId: "account", senderId: "sender" };
  const accepts = (identity: unknown) =>
    isReadRequest({
      databasePath: "/synthetic/state.sqlite",
      location: "/synthetic/state.sqlite",
      checkFreshAdmission: true,
      context: {
        environment: { OPENCLAW_STATE_DIR: "/synthetic" },
        coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
      },
      command: { type: "userProfiles.channelIdentity.resolve", identity },
    });
  expect(accepts(valid)).toBe(true);
  expect(accepts(null)).toBe(false);
  expect(accepts({ ...valid, extra: true })).toBe(false);
  for (const key of ["channelId", "accountId", "senderId"]) {
    expect(accepts({ ...valid, [key]: "x".repeat(512) })).toBe(true);
    for (const value of [undefined, 1, "", " trimmed ", "x".repeat(513)]) {
      expect(accepts({ ...valid, [key]: value })).toBe(false);
    }
  }
});

it.each([
  { name: "full snapshot", input: undefined, accepted: true },
  { name: "single task", input: { taskId: "task" }, accepted: true },
  {
    name: "scoped task",
    input: { taskId: "task", flowId: "flow", runId: "run", childSessionKey: "child" },
    accepted: true,
  },
  { name: "empty selection", input: [], accepted: true },
  { name: "task selection", input: [{ taskId: "first" }, { taskId: "second" }], accepted: true },
  { name: "null", input: null, accepted: false },
  { name: "string", input: "task", accepted: false },
  { name: "number", input: 1, accepted: false },
  { name: "missing task", input: {}, accepted: false },
  { name: "invalid task", input: { taskId: 1 }, accepted: false },
  { name: "invalid flow", input: { taskId: "task", flowId: null }, accepted: false },
  { name: "invalid run", input: { taskId: "task", runId: 1 }, accepted: false },
  { name: "invalid child", input: { taskId: "task", childSessionKey: [] }, accepted: false },
  { name: "null selection member", input: [null], accepted: false },
  { name: "incomplete selection member", input: [{ taskId: "first" }, {}], accepted: false },
])("validates task mutation snapshot request: $name", ({ input, accepted }) => {
  expect(
    isReadRequest({
      databasePath: "/synthetic/state.sqlite",
      location: "/synthetic/state.sqlite",
      checkFreshAdmission: true,
      context: {
        environment: { OPENCLAW_STATE_DIR: "/synthetic" },
        coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
      },
      command: { type: "tasks.mutationSnapshot", input },
    }),
  ).toBe(accepted);
});
