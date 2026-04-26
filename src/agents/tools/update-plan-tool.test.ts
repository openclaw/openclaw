import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRecoveryBundle, readTaskLedgerEvents } from "../session-recovery-state.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plan-tool-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
  });

  afterEach(async () => {
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

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

    expect(result.content).toEqual([]);
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

  it("records a recovery checkpoint when explicitly enabled", async () => {
    const tool = createUpdatePlanTool({
      recovery: {
        enabled: true,
        taskId: "task-plan",
        actorId: "avery",
        sessionId: "sess-1",
        workspaceId: "/tmp/openclaw",
      },
    });

    const result = await tool.execute("call-1", {
      explanation: "Continue implementation",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
      ],
    });

    expect(result.details).toMatchObject({ status: "updated", recovery: "recorded" });
    const ledger = readTaskLedgerEvents();
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      taskId: "task-plan",
      actorId: "avery",
      eventType: "plan_updated",
      summary: "Continue implementation",
      approvalStatus: "not_required",
    });
    expect(loadRecoveryBundle("task-plan")).toMatchObject({
      taskId: "task-plan",
      expiredApprovals: ["Approvals from prior sessions or turns are not inherited."],
      nextResumeAction: "Continue with plan step: Implement",
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

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });
});
