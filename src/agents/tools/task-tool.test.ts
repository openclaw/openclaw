import { afterEach, describe, expect, it } from "vitest";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { createTaskTool } from "./task-tool.js";

describe("task tool", () => {
  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("marks task as owner-only", () => {
    const tool = createTaskTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("creates/lists/gets task records", async () => {
    const tool = createTaskTool({ agentSessionKey: "agent:main:main" });

    const created = await tool.execute("call-create", {
      action: "create",
      task: "background sync",
      runtime: "cli",
      label: "sync",
    });
    const createdDetails = created.details as {
      status: string;
      task?: { taskId?: string; label?: string; task?: string };
    };
    expect(createdDetails.status).toBe("ok");
    expect(createdDetails.task?.label).toBe("sync");
    expect(createdDetails.task?.task).toBe("background sync");

    const listed = await tool.execute("call-list", { action: "list" });
    const listedDetails = listed.details as { count: number; tasks: Array<{ taskId: string }> };
    expect(listedDetails.count).toBe(1);

    const lookupTaskId = listedDetails.tasks[0]?.taskId;
    expect(lookupTaskId).toBeTruthy();

    const loaded = await tool.execute("call-get", {
      action: "get",
      taskId: lookupTaskId,
    });
    const loadedDetails = loaded.details as { task?: { taskId?: string } };
    expect(loadedDetails.task?.taskId).toBe(lookupTaskId);
  });

  it("updates, reads output, and stops tasks", async () => {
    const tool = createTaskTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });
    const created = await tool.execute("call-create", {
      action: "create",
      task: "index docs",
      runtime: "cli",
    });
    const taskId = (created.details as { task?: { taskId?: string } }).task?.taskId;
    expect(taskId).toBeTruthy();

    await tool.execute("call-update", {
      action: "update",
      taskId,
      progressSummary: "50%",
      notifyPolicy: "state_changes",
    });

    const output = await tool.execute("call-output", {
      action: "output",
      taskId,
    });
    const outputDetails = output.details as {
      output?: { progressSummary?: string | null; status?: string };
    };
    expect(outputDetails.output?.progressSummary).toBe("50%");
    expect(outputDetails.output?.status).toBe("queued");

    const stopped = await tool.execute("call-stop", {
      action: "stop",
      taskId,
    });
    const stoppedDetails = stopped.details as { cancelled?: boolean };
    expect(stoppedDetails.cancelled).toBe(true);
  });
});
