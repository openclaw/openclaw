import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
}));

vi.mock("../agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn((_cfg, _agentId) => "/workspace/main"),
  resolveSessionAgentId: vi.fn(() => "main"),
  listAgentIds: vi.fn(() => ["main", "agent1", "agent2"]),
}));

vi.mock("../../infra/task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({ release: vi.fn() })),
}));

vi.mock("../../infra/task-tracker.js", () => ({
  enableAgentManagedMode: vi.fn(),
  disableAgentManagedMode: vi.fn(),
}));

import {
  createTaskApproveTool,
  createTaskBlockTool,
  createTaskCancelTool,
  createTaskCompleteTool,
  createTaskListTool,
  createTaskResumeTool,
  createTaskStartTool,
  createTaskStatusTool,
  createTaskUpdateTool,
} from "./task-tool.js";

const mockConfig = { agents: { defaults: { workspace: "/workspace" } } } as never;

describe("task-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createTaskStartTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskStartTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskStartTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_start");
      expect(tool!.label).toBe("Task Start");
    });

    it("creates task with default priority", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Test task",
        simple: true,
      });

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.priority).toBe("medium");
      expect(parsed.taskId).toMatch(/^task_/);
    });

    it("respects custom priority", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Urgent task",
        priority: "urgent",
        simple: true,
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.priority).toBe("urgent");
    });

    it("includes context when provided", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      await tool!.execute("call-1", {
        description: "Task with context",
        context: "User requested via Discord",
        simple: true,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("## Context");
      expect(content).toContain("User requested via Discord");
    });

    it("creates simple task without steps", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Quick fix",
        simple: true,
      });
      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.simple).toBe(true);
      expect(parsed.stepsCount).toBeUndefined();

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("**Simple:** true");
      expect(content).not.toContain("## Steps");
    });

    it("rejects non-simple task_start calls that omit steps", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Resume PR #35 contract alignment and remaining follow-up work",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("STEP PLANNING REQUIRED");
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("creates task with steps, first step auto in_progress", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Multi-step task",
        steps: [
          { content: "Analyze code" },
          { content: "Implement changes" },
          { content: "Test and verify" },
        ],
      });
      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.stepsCount).toBe(3);
      expect(parsed.simple).toBeUndefined();

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("## Steps");
      expect(content).toContain("[>] (s1) Analyze code");
      expect(content).toContain("[ ] (s2) Implement changes");
      expect(content).toContain("[ ] (s3) Test and verify");
    });

    it("steps stay pending when requires_approval is true", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Approval task with steps",
        requires_approval: true,
        steps: [{ content: "Step A" }, { content: "Step B" }],
      });
      const parsed = result.details as Record<string, unknown>;
      expect(parsed.status).toBe("pending_approval");
      expect(parsed.stepsCount).toBe(2);

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("[ ] (s1) Step A");
      expect(content).toContain("[ ] (s2) Step B");
    });
  });

  describe("createTaskUpdateTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskUpdateTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskUpdateTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_update");
    });

    it("returns error when no active task and no task_id", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { progress: "Working on it" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No active task");
    });

    it("updates task with progress entry", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(existingTask);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { progress: "Added new feature" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.progressCount).toBe(2);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_abc123.md"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      expect(content).toContain("Added new feature");
    });
  });

  describe("createTaskCompleteTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskCompleteTool({});
      expect(tool).toBeNull();
    });

    it("archives task to monthly history file", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task-history")) {
          throw new Error("File not found");
        }
        return existingTask;
      });

      const tool = createTaskCompleteTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.archived).toBe(true);
      expect(parsed.archivedTo as string).toMatch(/^task-history\/\d{4}-\d{2}\.md$/);
      expect(fs.unlink).toHaveBeenCalled();
    });

    it("includes summary in history when provided", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task-history")) {
          return "# Task History - February 2026\n";
        }
        return existingTask;
      });

      const tool = createTaskCompleteTool({ config: mockConfig });
      await tool!.execute("call-1", { summary: "Successfully implemented feature" });

      const historyWrites = vi
        .mocked(fs.appendFile)
        .mock.calls.filter((call) => (call[0] as string).includes("task-history/"));
      expect(historyWrites.length).toBeGreaterThan(0);
      const allContent = historyWrites.map((call) => call[1] as string).join("");
      expect(allContent).toContain("Successfully implemented feature");
    });
  });

  describe("createTaskStatusTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskStatusTool({});
      expect(tool).toBeNull();
    });

    it("returns summary when no task_id provided", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.totalTasks).toBe(0);
      expect(parsed.byStatus).toBeDefined();
    });

    it("returns specific task when task_id provided", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Important task

## Progress
- Task started
- Working on it

## Last Activity
2026-02-04T11:30:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(existingTask);

      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_abc123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.found).toBe(true);
      expect(parsed.task.id).toBe("task_abc123");
      expect(parsed.task.priority).toBe("high");
      expect(parsed.task.progressCount).toBe(2);
    });
  });

  describe("createTaskListTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskListTool({});
      expect(tool).toBeNull();
    });

    it("returns empty list when no tasks", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.count).toBe(0);
      expect(parsed.tasks).toEqual([]);
    });

    it("filters by status", async () => {
      const inProgressTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task 1

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      const pendingTask = `# Task: task_def456

## Metadata
- **Status:** pending
- **Priority:** low
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Task 2

## Progress
- Task started

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md", "task_def456.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_abc123")) {
          return inProgressTask;
        }
        if ((filePath as string).includes("task_def456")) {
          return pendingTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { status: "in_progress" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.count).toBe(1);
      expect(parsed.tasks[0].id).toBe("task_abc123");
    });
  });

  describe("createTaskCancelTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskCancelTool({});
      expect(tool).toBeNull();
    });

    it("cancels task with reason", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_abc123")) {
          return existingTask;
        }
        if ((filePath as string).includes("TASK_HISTORY")) {
          throw new Error("Not found");
        }
        throw new Error("Not found");
      });

      const tool = createTaskCancelTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_abc123",
        reason: "No longer needed",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.cancelled).toBe(true);
      expect(parsed.reason).toBe("No longer needed");
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Not found"));

      const tool = createTaskCancelTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_nonexistent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });
  });

  describe("task file format", () => {
    it("generates valid markdown format", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      await tool!.execute("call-1", {
        description: "Test task description",
        context: "Test context",
        priority: "high",
        simple: true,
      });

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("tasks/task_"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("# Task:");
      expect(content).toContain("## Metadata");
      expect(content).toContain("- **Status:** in_progress");
      expect(content).toContain("- **Priority:** high");
      expect(content).toContain("## Description");
      expect(content).toContain("Test task description");
      expect(content).toContain("## Context");
      expect(content).toContain("Test context");
      expect(content).toContain("## Progress");
      expect(content).toContain("- Task started");
      expect(content).toContain("*Managed by task tools*");
    });
  });

  describe("priority sorting", () => {
    it("sorts tasks by priority then creation time", async () => {
      const urgentTask = `# Task: task_urgent

## Metadata
- **Status:** in_progress
- **Priority:** urgent
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Urgent task

## Progress
- Task started

## Last Activity
2026-02-04T12:00:00.000Z

---
*Managed by task tools*`;

      const lowTask = `# Task: task_low

## Metadata
- **Status:** in_progress
- **Priority:** low
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Low priority task

## Progress
- Task started

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;

      const highTask = `# Task: task_high

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T11:00:00.000Z

## Description
High priority task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([
        "task_low.md",
        "task_urgent.md",
        "task_high.md",
      ] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_urgent")) {
          return urgentTask;
        }
        if ((filePath as string).includes("task_low")) {
          return lowTask;
        }
        if ((filePath as string).includes("task_high")) {
          return highTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.tasks[0].id).toBe("task_urgent");
      expect(parsed.tasks[1].id).toBe("task_high");
      expect(parsed.tasks[2].id).toBe("task_low");
    });
  });

  describe("createTaskStartTool with requires_approval", () => {
    it("creates task with pending_approval status when requires_approval is true", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Task needing approval",
        requires_approval: true,
        simple: true,
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("pending_approval");
      expect(parsed.requiresApproval).toBe(true);
      expect(parsed.started).toBeNull();

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("tasks/task_"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** pending_approval");
      expect(content).toContain("- Task created - awaiting approval");
    });

    it("creates task with in_progress status when requires_approval is false", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Regular task",
        requires_approval: false,
        simple: true,
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.status).toBe("in_progress");
      expect(parsed.requiresApproval).toBe(false);
    });
  });

  describe("createTaskApproveTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskApproveTool({});
      expect(tool).toBeNull();
    });

    it("approves pending_approval task and transitions to in_progress", async () => {
      const pendingApprovalTask = `# Task: task_pending123

## Metadata
- **Status:** pending_approval
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task awaiting approval

## Progress
- Task created - awaiting approval

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_pending123")) {
          return pendingApprovalTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_pending123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.approved).toBe(true);
      expect(parsed.taskId).toBe("task_pending123");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_pending123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** in_progress");
      expect(content).toContain("- Task approved and started");
    });

    it("returns error when task is not pending_approval", async () => {
      const inProgressTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(inProgressTask);

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_active123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not pending approval");
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Not found"));

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_nonexistent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });
  });

  describe("createTaskBlockTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskBlockTool({});
      expect(tool).toBeNull();
    });

    it("rejects non-existent agent ID in unblock_by", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for external API",
        unblock_by: ["invalid_agent"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid agent ID");
      expect(parsed.error).toContain("invalid_agent");
      expect(parsed.error).toContain("Valid agents");
    });

    it("rejects self-reference (agent blocking with itself as unblocker)", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for something",
        unblock_by: ["main"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Agent cannot unblock itself");
      expect(parsed.error).toContain("main");
    });

    it("accepts valid agent IDs", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for agent1 to complete their task",
        unblock_by: ["agent1", "agent2"],
        unblock_action: "notify_agents",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("blocked");
      expect(parsed.blockedReason).toBe("Waiting for agent1 to complete their task");
      expect(parsed.unblockedBy).toEqual(["agent1", "agent2"]);
      expect(parsed.unblockedAction).toBe("notify_agents");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_active123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** blocked");
      expect(content).toContain("[BLOCKED] Waiting for agent1 to complete their task");
    });

    it("returns clear error message with invalid ID listed", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for help",
        unblock_by: ["agent1", "nonexistent_agent", "another_invalid"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("nonexistent_agent");
      expect(parsed.error).toContain("another_invalid");
      expect(parsed.error).toContain("Valid agents");
      expect(parsed.error).toContain("main");
      expect(parsed.error).toContain("agent1");
      expect(parsed.error).toContain("agent2");
    });

    it("blocks current task when task_id is not specified", async () => {
      const currentTaskPointer = "task_active123";
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_active123.md"]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("CURRENT_TASK")) {
          return currentTaskPointer;
        }
        if ((filePath as string).includes("task_active123")) {
          return activeTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        reason: "Waiting for external service",
        unblock_by: ["agent1"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("blocked");
      expect(parsed.taskId).toBe("task_active123");
    });
  });
  describe("createTaskResumeTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskResumeTool({});
      expect(tool).toBeNull();
    });

    it("resumes blocked task and transitions to in_progress", async () => {
      const blockedTask = `# Task: task_blocked123

## Metadata
- **Status:** blocked
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task waiting for unblock

## Progress
- Task started
- [BLOCKED] Waiting for agent1 to complete

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_blocked123")) {
          return blockedTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskResumeTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_blocked123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.resumed).toBe(true);
      expect(parsed.taskId).toBe("task_blocked123");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_blocked123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** in_progress");
      expect(content).toContain("- Task resumed from blocked state");
    });

    it("returns error when task is not blocked", async () => {
      const inProgressTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(inProgressTask);

      const tool = createTaskResumeTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_active123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not blocked");
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Not found"));

      const tool = createTaskResumeTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_nonexistent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    it("resumes most recently blocked task when task_id is not specified", async () => {
      const blockedTaskMd = `# Task: task_auto_blocked

## Metadata
- **Status:** blocked
- **Priority:** high
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Auto blocked task

## Progress
- Task started
- [BLOCKED] Need help

## Last Activity
2026-02-04T12:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_auto_blocked.md"] as unknown as Dirent[]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_auto_blocked")) {
          return blockedTaskMd;
        }
        throw new Error("Not found");
      });

      const tool = createTaskResumeTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.resumed).toBe(true);
      expect(parsed.taskId).toBe("task_auto_blocked");
    });

    it("returns error when no blocked tasks exist", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const tool = createTaskResumeTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No blocked task");
    });
  });
});

// Import backlog tools
import { createTaskBacklogAddTool, createTaskPickBacklogTool } from "./task-tool.js";

describe("backlog functionality", () => {
  describe("createTaskBacklogAddTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskBacklogAddTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_backlog_add");
      expect(tool!.label).toBe("Task Backlog Add");
    });

    it("creates backlog task with default priority", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { description: "Backlog task" });

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("backlog");
      expect(parsed.priority).toBe("medium");
      expect(parsed.isCrossAgent).toBe(false);
    });

    it("creates backlog task with estimated effort", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Large backlog task",
        estimated_effort: "large",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.estimatedEffort).toBe("large");
    });

    it("creates backlog task with start_date and due_date", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Scheduled task",
        start_date: "2026-03-01",
        due_date: "2026-03-15",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.startDate).toBe("2026-03-01");
      expect(parsed.dueDate).toBe("2026-03-15");
    });

    it("creates backlog task with dependencies", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Dependent task",
        depends_on: ["task_abc123", "task_def456"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.dependsOn).toEqual(["task_abc123", "task_def456"]);
    });

    it("respects requester priority for cross-agent requests", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Cross-agent task",
        priority: "urgent",
        assignee: "agent1",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.priority).toBe("urgent");
      expect(parsed.isCrossAgent).toBe(true);
      expect(parsed.assignee).toBe("agent1");
    });

    it("rejects invalid assignee", async () => {
      const tool = createTaskBacklogAddTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Invalid assignee task",
        assignee: "nonexistent_agent",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid assignee");
    });
  });

  describe("createTaskPickBacklogTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskPickBacklogTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskPickBacklogTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_pick_backlog");
      expect(tool!.label).toBe("Task Pick Backlog");
    });

    it("rejects pick when active task exists", async () => {
      const activeTask = `# Task: task_active

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_active.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskPickBacklogTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Already have an active task");
    });

    it("picks specific backlog task by task_id", async () => {
      const backlogTask = `# Task: task_backlog123

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Backlog task

## Progress
- Added to backlog

## Last Activity
2026-02-04T11:00:00.000Z

## Backlog
{"createdBy":"main","assignee":"main"}

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_backlog123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(backlogTask);

      const tool = createTaskPickBacklogTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_backlog123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.pickedFromBacklog).toBe(true);
      expect(parsed.taskId).toBe("task_backlog123");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_backlog123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** in_progress");
    });

    it("rejects task with future start_date", async () => {
      const futureTask = `# Task: task_future

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Future task

## Progress
- Added to backlog

## Last Activity
2026-02-04T11:00:00.000Z

## Backlog
{"startDate":"2099-01-01"}

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(futureTask);

      const tool = createTaskPickBacklogTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_future" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("cannot start until");
    });

    it("rejects task with unmet dependencies", async () => {
      const dependentTask = `# Task: task_dependent

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Dependent task

## Progress
- Added to backlog

## Last Activity
2026-02-04T11:00:00.000Z

## Backlog
{"dependsOn":["task_prereq"]}

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_dependent.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_dependent")) {
          return dependentTask;
        }
        if ((filePath as string).includes("task_prereq")) {
          return `# Task: task_prereq

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Prerequisite task

## Progress
- Working on it

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;
        }
        throw new Error("Not found");
      });

      const tool = createTaskPickBacklogTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_dependent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("unmet dependencies");
      expect(parsed.unmetDependencies).toContain("task_prereq");
    });

    it("returns error when no pickable backlog tasks", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const tool = createTaskPickBacklogTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No backlog tasks available");
    });
  });

  describe("backlog sorting", () => {
    it("sorts backlog by priority > due_date > start_date > created", async () => {
      const urgentTask = `# Task: task_urgent

## Metadata
- **Status:** backlog
- **Priority:** urgent
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Urgent backlog task

## Progress
- Added to backlog

## Last Activity
2026-02-04T12:00:00.000Z

---
*Managed by task tools*`;

      const mediumWithDueDate = `# Task: task_medium_due

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Medium with due date

## Progress
- Added to backlog

## Last Activity
2026-02-04T10:00:00.000Z

## Backlog
{"dueDate":"2026-02-10"}

---
*Managed by task tools*`;

      const mediumNoDueDate = `# Task: task_medium_nodue

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T09:00:00.000Z

## Description
Medium no due date

## Progress
- Added to backlog

## Last Activity
2026-02-04T09:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([
        "task_medium_nodue.md",
        "task_urgent.md",
        "task_medium_due.md",
      ] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_urgent")) {
          return urgentTask;
        }
        if ((filePath as string).includes("task_medium_due")) {
          return mediumWithDueDate;
        }
        if ((filePath as string).includes("task_medium_nodue")) {
          return mediumNoDueDate;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { status: "backlog" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.tasks[0].id).toBe("task_urgent");
      expect(parsed.tasks[1].id).toBe("task_medium_due");
      expect(parsed.tasks[2].id).toBe("task_medium_nodue");
    });
  });

  describe("task_list with backlog filter", () => {
    it("filters backlog tasks correctly", async () => {
      const backlogTask = `# Task: task_backlog

## Metadata
- **Status:** backlog
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Backlog task

## Progress
- Added to backlog

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      const inProgressTask = `# Task: task_active

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_backlog.md", "task_active.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_backlog")) {
          return backlogTask;
        }
        if ((filePath as string).includes("task_active")) {
          return inProgressTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { status: "backlog" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.count).toBe(1);
      expect(parsed.tasks[0].id).toBe("task_backlog");
      expect(parsed.filter).toBe("backlog");
    });
  });

  describe("task_update step actions", () => {
    const baseTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

    const taskWithSteps = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Steps
- [>] (s1) Do X
- [ ] (s2) Do Y
- [ ] (s3) Do Z

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

    it("set_steps initializes steps and auto-starts first one", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(baseTask);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "set_steps",
        steps: [{ content: "Step A" }, { content: "Step B" }, { content: "Step C" }],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      const steps = parsed.steps as Record<string, number>;
      expect(steps.totalSteps).toBe(3);
      expect(steps.inProgress).toBe(1);
      expect(steps.pending).toBe(2);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_abc123.md"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      expect(content).toContain("## Steps");
      expect(content).toContain("[>] (s1) Step A");
      expect(content).toContain("[ ] (s2) Step B");
    });

    it("complete_step marks step done and auto-starts next", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "complete_step",
        step_id: "s1",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      const steps = parsed.steps as Record<string, number>;
      expect(steps.done).toBe(1);
      expect(steps.inProgress).toBe(1);
    });

    it("add_step adds a new step with correct ID", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "add_step",
        step_content: "New step",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      const steps = parsed.steps as Record<string, number>;
      expect(steps.totalSteps).toBe(4);
    });

    it("skip_step marks step as skipped and auto-starts next", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "skip_step",
        step_id: "s1",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      const steps = parsed.steps as Record<string, number>;
      expect(steps.skipped).toBe(1);
      expect(steps.inProgress).toBe(1);
    });

    it("start_step starts a specific step, reverting current in_progress to pending", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "start_step",
        step_id: "s3",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      const steps = parsed.steps as Record<string, number>;
      expect(steps.inProgress).toBe(1);
      expect(steps.pending).toBe(2);
    });

    it("reorder_steps reorders steps", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "reorder_steps",
        steps_order: ["s3", "s1", "s2"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
    });

    it("set_steps with empty array returns error", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(baseTask);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "set_steps",
        steps: [],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
    });

    it("complete_step with invalid step_id returns error", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        action: "complete_step",
        step_id: "sNonexistent",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Step not found");
    });
  });

  describe("task_complete Stop Guard", () => {
    const taskWithIncompleteSteps = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Steps
- [x] (s1) Done step
- [>] (s2) In progress step
- [ ] (s3) Pending step

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

    const taskWithAllStepsDone = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Steps
- [x] (s1) Done step
- [x] (s2) Done step 2
- [-] (s3) Skipped step

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

    it("blocks completion when incomplete steps exist", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithIncompleteSteps);

      const tool = createTaskCompleteTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.blocked_by).toBe("stop_guard");
      const remaining = parsed.remaining_steps as Array<{ id: string }>;
      expect(remaining).toHaveLength(2);
    });

    it("allows force_complete with incomplete steps", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithIncompleteSteps);

      const tool = createTaskCompleteTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { force_complete: "true" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.archived).toBe(true);
    });

    it("allows completion when all steps are done or skipped", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithAllStepsDone);

      const tool = createTaskCompleteTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.archived).toBe(true);
    });
  });

  describe("Steps serialization roundtrip", () => {
    it("parseTaskFileMd handles all step markers via task_status", async () => {
      const taskWithAllMarkers = `# Task: task_markers

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Marker test

## Steps
- [x] (s1) Done
- [>] (s2) In progress
- [ ] (s3) Pending
- [-] (s4) Skipped

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_markers.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithAllMarkers);

      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_markers" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.found).toBe(true);
      const task = parsed.task as Record<string, unknown>;
      const steps = task.steps as Array<{ id: string; status: string }>;
      expect(steps).toHaveLength(4);
      expect(steps[0]).toMatchObject({ id: "s1", status: "done" });
      expect(steps[1]).toMatchObject({ id: "s2", status: "in_progress" });
      expect(steps[2]).toMatchObject({ id: "s3", status: "pending" });
      expect(steps[3]).toMatchObject({ id: "s4", status: "skipped" });
    });
  });

  describe("task_status with steps", () => {
    it("returns steps info for task with steps", async () => {
      const taskWithSteps = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Steps
- [x] (s1) Step 1
- [>] (s2) Step 2
- [ ] (s3) Step 3

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(taskWithSteps);

      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_abc123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.found).toBe(true);
      const task = parsed.task as Record<string, unknown>;
      expect(task.totalSteps).toBe(3);
      expect(task.done).toBe(1);
      expect(task.inProgress).toBe(1);
      expect(task.pending).toBe(1);
      expect(task.steps).toHaveLength(3);
    });
  });

  describe("task_list with steps", () => {
    it("returns stepsTotal and stepsDone for tasks with steps", async () => {
      const taskWithSteps = `# Task: task_with_steps

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task with steps

## Steps
- [x] (s1) Done
- [>] (s2) In progress
- [ ] (s3) Pending

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      const taskWithoutSteps = `# Task: task_without_steps

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Task without steps

## Progress
- Task started

## Last Activity
2026-02-04T12:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([
        "task_with_steps.md",
        "task_without_steps.md",
      ] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_with_steps")) {
          return taskWithSteps;
        }
        if ((filePath as string).includes("task_without_steps")) {
          return taskWithoutSteps;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      const withSteps = tasks.find((t) => t.id === "task_with_steps");
      const withoutSteps = tasks.find((t) => t.id === "task_without_steps");

      expect(withSteps!.stepsTotal).toBe(3);
      expect(withSteps!.stepsDone).toBe(1);
      expect(withoutSteps!.stepsTotal).toBeUndefined();
      expect(withoutSteps!.stepsDone).toBeUndefined();
    });
  });
});
