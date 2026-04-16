import { describe, expect, it } from "vitest";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool – parity tests", () => {
  it("cancelled status is accepted in the schema", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        { step: "Install deps", status: "completed" },
        { step: "Run failing tests", status: "cancelled" },
        { step: "Fix tests and retry", status: "pending" },
      ],
    });

    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "Install deps", status: "completed" },
        { step: "Run failing tests", status: "cancelled" },
        { step: "Fix tests and retry", status: "pending" },
      ],
    });
  });

  it("activeForm field is preserved in output", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        {
          step: "Fix auth bug",
          status: "in_progress",
          activeForm: "Fixing authentication bug",
        },
        { step: "Deploy", status: "pending" },
      ],
    });

    const plan = (result.details as Record<string, unknown>).plan as Array<Record<string, unknown>>;
    const inProgressStep = plan.find((s) => s.status === "in_progress");
    expect(inProgressStep).toBeDefined();
    expect(inProgressStep!.activeForm).toBe("Fixing authentication bug");
  });

  it("merge=true with no previousPlan falls back to replace", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      merge: true,
      plan: [
        { step: "New step", status: "pending" },
      ],
    });

    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "New step", status: "pending" },
      ],
    });
  });
});
