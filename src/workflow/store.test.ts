import { rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWorkflowStoreManager } from "./store.js";

describe("WorkflowStoreManager", () => {
  const testDir = join(tmpdir(), "openclaw-workflow-test-" + Date.now());
  const testAgentId = "test-agent";
  let manager: ReturnType<typeof createWorkflowStoreManager>;
  let planId = "";
  let taskIds: string[] = [];

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

  it("should create a workflow plan", async () => {
    const plan = await manager.createPlan({
      agentId: testAgentId,
      title: "Test Workflow",
      description: "Testing all operations",
      source: "manual",
      tasks: [{ content: "Task 1" }, { content: "Task 2" }, { content: "Task 3" }],
    });

    expect(plan).toBeDefined();
    expect(plan.id).toMatch(/^wfp_/);
    expect(plan.title).toBe("Test Workflow");
    expect(plan.tasks).toHaveLength(3);
    expect(plan.status).toBe("pending");

    planId = plan.id;
    taskIds = plan.tasks.map((t) => t.id);
  });

  it("should list active plans", async () => {
    const plans = await manager.getActivePlans();
    expect(plans).toBeInstanceOf(Array);
    expect(plans.some((p) => p.id === planId)).toBe(true);
  });

  it("should get a specific active plan", async () => {
    const plan = await manager.getActivePlan(planId);
    expect(plan).toBeDefined();
    expect(plan?.id).toBe(planId);
    expect(plan?.title).toBe("Test Workflow");
  });

  it("should start a task", async () => {
    const plan = await manager.startTask(planId, taskIds[0]);
    expect(plan).toBeDefined();

    const task = plan?.tasks.find((t) => t.id === taskIds[0]);
    expect(task?.status).toBe("in_progress");
    expect(task?.startedAt).toBeDefined();
  });

  it("should update a task status", async () => {
    const plan = await manager.updateTask({
      planId,
      taskId: taskIds[0],
      status: "completed",
      result: "Task 1 done",
    });

    expect(plan).toBeDefined();
    const task = plan?.tasks.find((t) => t.id === taskIds[0]);
    expect(task?.status).toBe("completed");
    expect(task?.result).toBe("Task 1 done");
    expect(task?.completedAt).toBeDefined();
  });

  it("should update plan metadata", async () => {
    const plan = await manager.updatePlan(planId, {
      description: "Updated description",
      metadata: { testKey: "testValue" },
    });

    expect(plan).toBeDefined();
    expect(plan?.description).toBe("Updated description");
    expect(plan?.metadata?.testKey).toBe("testValue");
  });

  it("should complete a workflow plan", async () => {
    // Complete remaining tasks first
    for (let i = 1; i < taskIds.length; i++) {
      await manager.startTask(planId, taskIds[i]);
      await manager.updateTask({
        planId,
        taskId: taskIds[i],
        status: "completed",
      });
    }

    const plan = await manager.completePlan(planId, "completed");
    expect(plan).toBeDefined();
    expect(plan?.status).toBe("completed");
    expect(plan?.completedAt).toBeDefined();
  });

  it("should list history plans", async () => {
    const history = await manager.listHistory({ limit: 10, offset: 0 });
    expect(history.plans).toBeInstanceOf(Array);
    expect(history.plans.some((p) => p.id === planId)).toBe(true);
    expect(history.total).toBeGreaterThanOrEqual(1);
  });

  it("should get a specific history plan", async () => {
    const plan = await manager.getHistoryPlan(planId);
    expect(plan).toBeDefined();
    expect(plan?.id).toBe(planId);
    expect(plan?.status).toBe("completed");
  });

  it("should delete a workflow plan", async () => {
    const deleted = await manager.deletePlan(planId);
    expect(deleted).toBe(true);

    // Verify deletion
    const plan = await manager.getHistoryPlan(planId);
    expect(plan).toBeNull();
  });

  it("should return null for non-existent plan", async () => {
    const plan = await manager.getActivePlan("non-existent-id");
    expect(plan).toBeNull();
  });

  it("should handle task failure status", async () => {
    // Create a new plan for failure test
    const plan = await manager.createPlan({
      agentId: testAgentId,
      title: "Failure Test",
      source: "manual",
      tasks: [{ content: "Will fail" }],
    });

    const taskId = plan.tasks[0].id;

    await manager.startTask(plan.id, taskId);
    const updated = await manager.updateTask({
      planId: plan.id,
      taskId,
      status: "failed",
      error: "Something went wrong",
    });

    const task = updated?.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error).toBe("Something went wrong");

    // Cleanup
    await manager.deletePlan(plan.id);
  });
});
