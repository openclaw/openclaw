import { describe, expect, it } from "vitest";
import { selectSupervisorActionFromRelation } from "./action-selection.js";

describe("selectSupervisorActionFromRelation", () => {
  it("uses taxonomy defaults for known relations", () => {
    expect(selectSupervisorActionFromRelation("same_task_supplement")).toBe("append");
    expect(selectSupervisorActionFromRelation("new_task_replace")).toBe("abort_and_replace");
  });

  it("falls back to continue when relation is missing", () => {
    expect(selectSupervisorActionFromRelation(undefined)).toBe("continue");
  });
});
