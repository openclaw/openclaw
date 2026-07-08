import { describe, expect, it } from "vitest";
import { extractPlanChecklist } from "./plan-checklist.ts";
import { formatPlanProgress } from "./session-plan.ts";

// Shape mirrors a live update_plan tool result on the stream:plan / tool agent-event path.
function updatePlanResult(
  steps: { step: string; status: string }[],
  explanation?: string,
): unknown {
  return {
    content: [],
    details: { status: "updated", ...(explanation ? { explanation } : {}), plan: steps },
  };
}

describe("extractPlanChecklist", () => {
  it("reads steps + explanation from an update_plan tool result", () => {
    const checklist = extractPlanChecklist(
      updatePlanResult(
        [
          { step: "Research", status: "completed" },
          { step: "Implement", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
        "narrowed scope",
      ),
    );
    expect(checklist).toEqual({
      explanation: "narrowed scope",
      steps: [
        { step: "Research", status: "completed" },
        { step: "Implement", status: "in_progress" },
        { step: "Test", status: "pending" },
      ],
    });
  });

  it("returns null for non-plan tool results or malformed payloads", () => {
    expect(extractPlanChecklist(undefined)).toBeNull();
    expect(extractPlanChecklist({ details: { status: "ok" } })).toBeNull();
    expect(extractPlanChecklist({ details: { plan: [] } })).toBeNull();
    expect(
      extractPlanChecklist({ details: { plan: [{ step: "x", status: "bogus" }] } }),
    ).toBeNull();
    expect(extractPlanChecklist({ details: { plan: [{ status: "pending" }] } })).toBeNull();
  });

  it("formats progress from step statuses", () => {
    const checklist = extractPlanChecklist(
      updatePlanResult([
        { step: "a", status: "completed" },
        { step: "b", status: "completed" },
        { step: "c", status: "in_progress" },
      ]),
    );
    expect(formatPlanProgress(checklist!.steps)).toBe("2/3 done");
  });
});
