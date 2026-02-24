/**
 * TaskCreate Tool Tests
 * Tests for adding new tasks to the team ledger
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTaskCreateTool } from "./task-create.js";

// Helper type for test data assertions
type TaskCreateResultData = {
  taskId: string;
  teamName: string;
  status: string;
  message: string;
};

// Mock randomUUID to return predictable values
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-task-uuid-1234"),
}));

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  readTeamConfig: vi.fn(),
  validateTeamNameOrThrow: vi.fn(),
}));

// Mock manager and pool modules
vi.mock("../../../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
}));

describe("TaskCreate Tool", () => {
  let mockManager: {
    createTask: ReturnType<typeof vi.fn>;
    addTaskDependency: ReturnType<typeof vi.fn>;
    detectCircularDependencies: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock manager
    mockManager = {
      createTask: vi.fn().mockReturnValue({
        id: "test-task-uuid-1234",
        subject: "Mock task",
        description: "Mock description",
        status: "pending" as const,
        createdAt: Date.now(),
        dependsOn: [],
        blockedBy: [],
        blocks: [],
      }),
      addTaskDependency: vi.fn().mockReturnValue(true),
      detectCircularDependencies: vi.fn().mockReturnValue([]),
    };

    // Reset environment variable
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe("Basic Task Creation", () => {
    it("should create task and return task ID", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Implement feature",
        description: "Detailed description of the feature",
      });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("my-team");
      expect(getTeamManager).toHaveBeenCalledWith("my-team", process.cwd());
      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Implement feature",
        "Detailed description of the feature",
        {
          activeForm: undefined,
          metadata: undefined,
        },
      );

      const details = result.details as TaskCreateResultData;
      expect(details.taskId).toBe("test-task-uuid-1234");
      expect(details.teamName).toBe("my-team");
      expect(details.status).toBe("pending");
      expect(details.message).toContain("Implement feature");
      expect(details.message).toContain("test-task-uuid-1234");
    });

    it("should store task in ledger", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "test-team",
        subject: "Test task",
        description: "Test description",
      });

      expect(mockManager.createTask).toHaveBeenCalledTimes(1);
    });

    it("should set initial status to pending", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
      });

      expect((result.details as TaskCreateResultData).status).toBe("pending");
    });
  });

  describe("Active Form", () => {
    it("should store active form in task", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Run tests",
        description: "Execute test suite",
        activeForm: "Running tests",
      });

      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Run tests",
        "Execute test suite",
        expect.objectContaining({
          activeForm: "Running tests",
        }),
      );
    });

    it("should handle missing activeForm gracefully", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
      });

      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Test task",
        "Test description",
        expect.objectContaining({
          activeForm: undefined,
        }),
      );
    });
  });

  describe("Metadata", () => {
    it("should store metadata as JSON", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const metadata = {
        priority: "high",
        estimatedHours: 4,
        labels: ["frontend", "urgent"],
      };

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Fix bug",
        description: "Critical bug fix",
        metadata,
      });

      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Fix bug",
        "Critical bug fix",
        expect.objectContaining({
          metadata,
        }),
      );
    });

    it("should handle complex nested metadata", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const metadata = {
        context: {
          project: "openclaw",
          module: "teams",
        },
        references: ["issue-123", "pr-456"],
        deadline: new Date("2026-03-01").toISOString(),
      };

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Complex task",
        description: "Task with complex metadata",
        metadata,
      });

      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Complex task",
        "Task with complex metadata",
        expect.objectContaining({
          metadata,
        }),
      );
    });

    it("should handle missing metadata gracefully", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
      });

      expect(mockManager.createTask).toHaveBeenCalledWith(
        "Test task",
        "Test description",
        expect.objectContaining({
          metadata: undefined,
        }),
      );
    });
  });

  describe("Dependencies", () => {
    it("should store dependsOn in task", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const dependsOn = ["task-1", "task-2", "task-3"];

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Dependent task",
        description: "Task that depends on others",
        dependsOn,
      });

      // Dependencies should be added via addTaskDependency
      expect(mockManager.addTaskDependency).toHaveBeenCalledTimes(3);
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith("test-task-uuid-1234", "task-1");
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith("test-task-uuid-1234", "task-2");
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith("test-task-uuid-1234", "task-3");
    });

    it("should handle empty dependsOn array", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
        dependsOn: [],
      });

      // Empty array should not call addTaskDependency
      expect(mockManager.addTaskDependency).not.toHaveBeenCalled();
    });

    it("should handle missing dependsOn gracefully", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
      });

      // Missing dependsOn should not call addTaskDependency
      expect(mockManager.addTaskDependency).not.toHaveBeenCalled();
    });

    it("should pass dependencies through to manager", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();
      const dependsOn = ["existing-task-1", "existing-task-2"];

      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Task with dependencies",
        description: "Task that has dependencies",
        dependsOn,
      });

      expect(mockManager.addTaskDependency).toHaveBeenCalledTimes(2);
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith(
        "test-task-uuid-1234",
        "existing-task-1",
      );
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith(
        "test-task-uuid-1234",
        "existing-task-2",
      );
    });
  });

  describe("Validation Errors", () => {
    it("should validate team name format", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: MyTeam. Must contain only lowercase letters, numbers, and hyphens",
        );
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "MyTeam",
          subject: "Test task",
          description: "Test description",
        }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject empty team name", async () => {
      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "",
          subject: "Test task",
          description: "Test description",
        }),
      ).rejects.toThrow("team_name required");
    });

    it("should reject empty subject", async () => {
      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          subject: "",
          description: "Test description",
        }),
      ).rejects.toThrow("subject required");
    });

    it("should reject missing subject", async () => {
      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          description: "Test description",
        } as unknown),
      ).rejects.toThrow("subject required");
    });

    it("should reject empty description", async () => {
      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          subject: "Test task",
          description: "",
        }),
      ).rejects.toThrow("description required");
    });

    it("should reject missing description", async () => {
      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          subject: "Test task",
        } as unknown),
      ).rejects.toThrow("description required");
    });

    it("should use OPENCLAW_STATE_DIR environment variable when set", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      process.env.OPENCLAW_STATE_DIR = "/custom/state/dir";

      const tool = createTaskCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Test task",
        description: "Test description",
      });

      expect(getTeamManager).toHaveBeenCalledWith("my-team", "/custom/state/dir");

      delete process.env.OPENCLAW_STATE_DIR;
    });
  });

  describe("Circular Dependency Detection", () => {
    it("should handle circular dependency error from manager", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      mockManager.createTask.mockImplementation(() => {
        throw new Error("Circular dependency detected: task-1 -> task-2 -> task-1");
      });

      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          subject: "Task with cycle",
          description: "Task that creates a cycle",
          dependsOn: ["task-2"],
        }),
      ).rejects.toThrow("Circular dependency");
    });

    it("should propagate dependency validation errors", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      mockManager.createTask.mockImplementation(() => {
        throw new Error("Dependency task-999 does not exist");
      });

      const tool = createTaskCreateTool();

      await expect(
        tool.execute("tool-call-1", {
          team_name: "my-team",
          subject: "Task with invalid dependency",
          description: "Task with non-existent dependency",
          dependsOn: ["task-999"],
        }),
      ).rejects.toThrow("Dependency task-999 does not exist");
    });

    it("should create task successfully when dependencies are valid", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTaskCreateTool();

      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        subject: "Valid dependent task",
        description: "Task with valid dependencies",
        dependsOn: ["task-1", "task-2"],
      });

      // Verify addTaskDependency was called for each dependency
      expect(mockManager.addTaskDependency).toHaveBeenCalledTimes(2);
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith("test-task-uuid-1234", "task-1");
      expect(mockManager.addTaskDependency).toHaveBeenCalledWith("test-task-uuid-1234", "task-2");
      expect(result.details.taskId).toBe("test-task-uuid-1234");
      expect((result.details as TaskCreateResultData).status).toBe("pending");
    });
  });
});
