import { rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHeartbeatWorkflowStatus, buildHeartbeatWorkflowPromptSection } from "./heartbeat.js";
import { createWorkflowStoreManager } from "./store.js";

describe("Heartbeat Workflow Integration", () => {
  const testDir = join(tmpdir(), "openclaw-heartbeat-test-" + Date.now());
  const testAgentId = "heartbeat-test-agent";
  let manager: ReturnType<typeof createWorkflowStoreManager>;
  let planId = "";

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    process.env.OPENCLAW_DATA_DIR = testDir;
    manager = createWorkflowStoreManager(testAgentId);
  });

  afterAll(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should return hasActivePlan=false when no plans exist", async () => {
    const status = await getHeartbeatWorkflowStatus({ agentId: testAgentId });
    expect(status.hasActivePlan).toBe(false);
  });

  it("should detect active plan after creation", async () => {
    const plan = await manager.createPlan({
      agentId: testAgentId,
      title: "Heartbeat Test Plan",
      source: "heartbeat",
      tasks: [{ content: "Task A" }, { content: "Task B" }],
    });
    planId = plan.id;

    const status = await getHeartbeatWorkflowStatus({ agentId: testAgentId });
    expect(status.hasActivePlan).toBe(true);
    expect(status.activePlan?.id).toBe(planId);
    expect(status.progress?.total).toBe(2);
    expect(status.progress?.completed).toBe(0);
  });

  it("should update progress when task is completed", async () => {
    const taskId = (await manager.getActivePlan(planId))!.tasks[0].id;
    await manager.startTask(planId, taskId);
    await manager.updateTask({
      planId,
      taskId,
      status: "completed",
    });

    const status = await getHeartbeatWorkflowStatus({ agentId: testAgentId });
    expect(status.progress?.completed).toBe(1);
    expect(status.progress?.percent).toBe(50);
  });

  it("should generate prompt section with active plan info", async () => {
    const status = await getHeartbeatWorkflowStatus({ agentId: testAgentId });
    const section = buildHeartbeatWorkflowPromptSection(status);

    expect(section).toContain("## Active Workflow Plan");
    expect(section).toContain("Heartbeat Test Plan");
    expect(section).toContain("1/2 tasks completed");
    expect(section).toContain("### Pending Tasks:");
    expect(section).toContain(`Plan ID: ${planId}`);
  });

  it("should return empty prompt section when no active plan", async () => {
    const status = { hasActivePlan: false };
    const section = buildHeartbeatWorkflowPromptSection(status);
    expect(section).toBe("");
  });

  it("should filter by sessionKey when provided", async () => {
    // Create plan with specific sessionKey
    const sessionPlan = await manager.createPlan({
      agentId: testAgentId,
      sessionKey: "session-123",
      title: "Session Plan",
      source: "heartbeat",
      tasks: [{ content: "Session task" }],
    });

    // Query with matching sessionKey
    const status = await getHeartbeatWorkflowStatus({
      agentId: testAgentId,
      sessionKey: "session-123",
    });

    expect(status.hasActivePlan).toBe(true);
    // Should find a plan (either session-specific or general)
    expect(status.activePlan).toBeDefined();

    // Cleanup
    await manager.deletePlan(sessionPlan.id);
  });

  it("should return hasActivePlan=false after plan completion", async () => {
    // Complete remaining task
    const plan = await manager.getActivePlan(planId);
    const pendingTask = plan?.tasks.find((t) => t.status === "pending");
    if (pendingTask) {
      await manager.startTask(planId, pendingTask.id);
      await manager.updateTask({
        planId,
        taskId: pendingTask.id,
        status: "completed",
      });
    }

    await manager.completePlan(planId, "completed");

    const status = await getHeartbeatWorkflowStatus({ agentId: testAgentId });
    expect(status.hasActivePlan).toBe(false);

    // Cleanup
    await manager.deletePlan(planId);
  });
});
