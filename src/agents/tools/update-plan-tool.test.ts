import { describe, expect, it } from "vitest";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool", () => {
  it("returns a compact success payload", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    // PR-8 follow-up: returns non-empty text content (lossless-claw fix);
    // the exact summary text varies by step count and terminal-state.
    //
    // Copilot review #68939 (2026-04-19): split the combined
    // `Array.isArray(...) && length > 0` assertion into two
    // separate assertions so test failures pinpoint whether the
    // problem was "wrong type" vs "empty content" instead of just
    // "expected true got false".
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.details).toEqual({
      status: "updated",
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("rejects multiple in-progress steps", async () => {
    const tool = createUpdatePlanTool();

    await expect(
      tool.execute("call-1", {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("plan can contain at most one in_progress step");
  });

  it("ignores extra per-step fields instead of rejecting the plan", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        { step: "Inspect harness", status: "completed", owner: "agent-1" },
        { step: "Run tests", status: "pending", notes: ["later"] },
      ],
    });

    // Copilot review #68939 (post-nuclear-fix-stack): split combined
    // assertion for diagnostic clarity (matches the same fix applied
    // to the test above this one).
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  // PR-9 Wave A2: plan close-on-complete.
  describe("close-on-complete (Wave A2)", () => {
    it("flips details.status to 'completed' when every step is terminal", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          { step: "A", status: "completed" },
          { step: "B", status: "cancelled" },
          { step: "C", status: "completed" },
        ],
      });
      expect(result.details).toMatchObject({ status: "completed" });
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toMatch(/Plan complete/);
    });

    it("stays 'updated' when any step is non-terminal", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          { step: "A", status: "completed" },
          { step: "B", status: "pending" },
        ],
      });
      expect(result.details).toMatchObject({ status: "updated" });
    });

    it("treats all-cancelled as completed (no celebration but still terminal)", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          { step: "A", status: "cancelled" },
          { step: "B", status: "cancelled" },
        ],
      });
      expect(result.details).toMatchObject({ status: "completed" });
    });
  });

  // PR-9 Wave B1: closure gate (acceptanceCriteria + verifiedCriteria).
  describe("closure gate (Wave B1)", () => {
    it("rejects status:'completed' when acceptanceCriteria are unverified", async () => {
      const tool = createUpdatePlanTool();
      await expect(
        tool.execute("call-1", {
          plan: [
            {
              step: "Provision VM",
              status: "completed",
              acceptanceCriteria: ["VM is reachable via SSH", "cortex_owner is set"],
              // verifiedCriteria omitted — should reject
            },
          ],
        }),
      ).rejects.toThrow(/2 acceptance criteria not yet verified/);
    });

    it("rejects status:'completed' when verifiedCriteria is partial", async () => {
      const tool = createUpdatePlanTool();
      await expect(
        tool.execute("call-1", {
          plan: [
            {
              step: "Provision VM",
              status: "completed",
              acceptanceCriteria: ["A", "B", "C"],
              verifiedCriteria: ["A"],
            },
          ],
        }),
      ).rejects.toThrow(/2 acceptance criteria not yet verified/);
    });

    it("accepts status:'completed' when all criteria are verified", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          {
            step: "Provision VM",
            status: "completed",
            acceptanceCriteria: ["A", "B"],
            verifiedCriteria: ["A", "B"],
          },
        ],
      });
      expect(result.details).toMatchObject({ status: "completed" });
    });

    it("rejects verifiedCriteria entries that aren't in acceptanceCriteria", async () => {
      const tool = createUpdatePlanTool();
      await expect(
        tool.execute("call-1", {
          plan: [
            {
              step: "X",
              status: "in_progress",
              acceptanceCriteria: ["valid-1"],
              verifiedCriteria: ["valid-1", "phantom"],
            },
          ],
        }),
      ).rejects.toThrow(/"phantom" is not in acceptanceCriteria/);
    });

    it("rejects verifiedCriteria without acceptanceCriteria", async () => {
      const tool = createUpdatePlanTool();
      await expect(
        tool.execute("call-1", {
          plan: [
            {
              step: "X",
              status: "in_progress",
              verifiedCriteria: ["a", "b"],
            },
          ],
        }),
      ).rejects.toThrow(/requires plan\[0\].acceptanceCriteria to be set/);
    });

    it("permits status:'in_progress' even without verified criteria", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          {
            step: "X",
            status: "in_progress",
            acceptanceCriteria: ["A", "B"],
            // verifiedCriteria intentionally empty/missing
          },
        ],
      });
      expect(result.details).toMatchObject({ status: "updated" });
    });

    it("permits status:'completed' when no criteria are declared (backwards-compat)", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [{ step: "Simple step", status: "completed" }],
      });
      expect(result.details).toMatchObject({ status: "completed" });
    });

    it("includes acceptanceCriteria + verifiedCriteria in returned plan", async () => {
      const tool = createUpdatePlanTool();
      const result = await tool.execute("call-1", {
        plan: [
          {
            step: "X",
            status: "in_progress",
            acceptanceCriteria: ["A"],
            verifiedCriteria: [],
          },
        ],
      });
      const planFromDetails = (result.details as { plan: Array<{ acceptanceCriteria?: string[] }> })
        .plan;
      expect(planFromDetails[0].acceptanceCriteria).toEqual(["A"]);
    });
  });
});
