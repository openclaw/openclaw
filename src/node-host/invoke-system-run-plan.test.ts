import { describe, expect, it } from "vitest";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";

describe("buildSystemRunApprovalPlan", () => {
  it("keeps rawCommand null for direct argv execution", () => {
    const prepared = buildSystemRunApprovalPlan({
      command: [process.execPath, "--version"],
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.plan.rawCommand).toBeNull();
  });
});
