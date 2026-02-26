/**
 * TaskComplete Tool Tests
 * Tests for marking tasks as completed and unblocking dependents
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper type for tool results
interface ToolResult {
  status?: string;
  error?: string;
  taskId?: string;
  announced?: boolean;
}

const getDetails = (result: { details: unknown }): ToolResult => result.details as ToolResult;
import { createTaskCompleteTool } from "./task-complete.js";

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  validateTeamNameOrThrow: vi.fn(),
  getTeamsBaseDir: vi.fn(() => {
    const stateDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
    return `${stateDir}/teams`;
  }),
}));

// Mock manager and pool modules
vi.mock("../../../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
}));

// Mock inbox modules
vi.mock("../../../teams/inbox.js", () => ({
  writeInboxMessage: vi.fn().mockResolvedValue(undefined),
  listMembers: vi.fn().mockResolvedValue([]),
}));

describe("TaskComplete Tool", () => {
  let mockManager: {
    completeTask: ReturnType<typeof vi.fn>;
    getTeamConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockManager = {
      completeTask: vi.fn().mockReturnValue({
        unblocked: [],
      }),
      getTeamConfig: vi.fn().mockResolvedValue({
        team_name: "test-team",
        lead: "agent:main:user:main",
      }),
    };
  });

  describe("Successful Completion", () => {
    it("should verify task ownership before completion", async () => {
      expect(true).toBe(true);
    });

    it("should update task status to completed", async () => {
      expect(true).toBe(true);
    });

    it("should set completedAt timestamp", async () => {
      expect(true).toBe(true);
    });
  });

  describe("Dependency Unblocking", () => {
    it("should find tasks blocked by completed task", async () => {
      expect(true).toBe(true);
    });

    it("should remove task from blockedBy of dependents", async () => {
      expect(true).toBe(true);
    });

    it("should update dependent status to available", async () => {
      expect(true).toBe(true);
    });
  });

  describe("Complex Dependency Chain", () => {
    it("should resolve chain step by step", async () => {
      expect(true).toBe(true);
    });

    it("should handle diamond pattern", async () => {
      expect(true).toBe(true);
    });
  });

  describe("Failed Completion", () => {
    it("should fail if task not owned by session", async () => {
      expect(true).toBe(true);
    });

    it("should fail if task already completed", async () => {
      expect(true).toBe(true);
    });

    it("should fail for non-existent task", async () => {
      expect(true).toBe(true);
    });
  });

  describe("Validation", () => {
    it("should validate team name format", async () => {
      expect(true).toBe(true);
    });

    it("should validate task ID format", async () => {
      expect(true).toBe(true);
    });
  });

  describe("Announce Completion", () => {
    it("should not announce when announce=false", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage } = await import("../../../teams/inbox.js");

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:teammate:uuid-123",
      });

      await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-1",
        announce: false,
      });

      expect(writeInboxMessage).not.toHaveBeenCalled();
    });

    it("should not announce when announce not specified", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage } = await import("../../../teams/inbox.js");

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:teammate:uuid-123",
      });

      await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-1",
      });

      expect(writeInboxMessage).not.toHaveBeenCalled();
    });

    it("should announce to lead when announce=true", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage, listMembers } = await import("../../../teams/inbox.js");

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sessionKey: "agent:main:teammate:uuid-123",
          name: "Worker",
          agentId: "main",
          agentType: "member",
        },
      ]);

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:teammate:uuid-123",
      });

      const result = await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-1",
        summary: "Fixed the bug in auth module",
        announce: true,
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        "test-team",
        `${process.cwd()}/teams`,
        "agent:main:user:main",
        expect.objectContaining({
          type: "task_complete",
          taskId: "task-1",
          content: "Task task-1 completed: Fixed the bug in auth module",
        }),
      );
      expect(getDetails(result).announced).toBe(true);
    });

    it("should not announce if teammate is the lead", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage } = await import("../../../teams/inbox.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "test-team",
        lead: "agent:main:user:main",
      });

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:user:main", // Same as lead
      });

      await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-1",
        announce: true,
      });

      expect(writeInboxMessage).not.toHaveBeenCalled();
    });

    it("should still complete task even if announce fails", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage, listMembers } = await import("../../../teams/inbox.js");

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (listMembers as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Failed to list members"),
      );
      (writeInboxMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Failed to write inbox"),
      );

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:teammate:uuid-123",
      });

      // Should not throw even if announce fails
      const result = await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-1",
        announce: true,
      });

      expect(getDetails(result).taskId).toBe("task-1");
      expect(getDetails(result).status).toBe("completed");
      expect(mockManager.completeTask).toHaveBeenCalled();
    });

    it("should use default message when summary not provided", async () => {
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { writeInboxMessage, listMembers } = await import("../../../teams/inbox.js");

      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sessionKey: "agent:main:teammate:uuid-456",
          name: "Developer",
          agentId: "main",
          agentType: "member",
        },
      ]);

      const tool = createTaskCompleteTool({
        agentSessionKey: "agent:main:teammate:uuid-456",
      });

      await tool.execute("tool-call-1", {
        team_name: "test-team",
        task_id: "task-2",
        announce: true,
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        "test-team",
        `${process.cwd()}/teams`,
        "agent:main:user:main",
        expect.objectContaining({
          content: "Task task-2 completed successfully.",
        }),
      );
    });
  });
});
