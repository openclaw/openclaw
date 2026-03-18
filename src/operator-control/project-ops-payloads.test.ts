import { describe, expect, it } from "vitest";
import {
  classifyProjectOpsUpdatePayload,
  parseProjectOpsUpdatePayload,
} from "./project-ops-payloads.js";

describe("project-ops payloads", () => {
  it("normalizes direct item mutation payloads", () => {
    expect(
      parseProjectOpsUpdatePayload({
        itemUrl: "https://github.com/openclaw/openclaw/issues/1",
        set: { status: "Done" },
        clear: ["curr"],
      }),
    ).toEqual({
      item_url: "https://github.com/openclaw/openclaw/issues/1",
      set: { status: "Done" },
      clear: ["curr"],
    });
  });

  it("redirects Paw and Order payloads to the task route", () => {
    expect(
      classifyProjectOpsUpdatePayload({
        schema: "PawAndOrderTaskV1",
        task_id: "task-1",
        objective: "Clean up blockers",
        capability: "kanban",
      }),
    ).toMatchObject({
      kind: "project-ops-task",
    });
  });

  it("redirects lifecycle payloads to the operator events route", () => {
    expect(
      classifyProjectOpsUpdatePayload({
        schema: "DebOperatorTaskSyncV1",
        task_id: "task-1",
        run_id: "run-1",
        state: "accepted",
      }),
    ).toMatchObject({
      kind: "task-lifecycle",
    });
  });

  it("reports unmapped fields instead of allowing passthrough updates", () => {
    expect(() =>
      parseProjectOpsUpdatePayload({
        item_url: "https://github.com/openclaw/openclaw/issues/1",
        title: "Unexpected legacy field",
      }),
    ).toThrow("Unmapped fields: title");
  });
});
