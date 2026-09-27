import { expect, it } from "vitest";
import { isReadRequest } from "./openclaw-state-read.validation.js";

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
      },
      command: { type: "tasks.mutationSnapshot", input },
    }),
  ).toBe(accepted);
});
