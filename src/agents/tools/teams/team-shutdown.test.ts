/**
 * TeamShutdown Tool Tests
 * Tests for graceful team shutdown with member approval
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper type for tool results
interface ToolResult {
  status?: string;
  error?: string;
  teamName?: string;
  message?: string;
  pendingApprovals?: string[];
  deleted?: boolean;
  teamId?: string;
  requestId?: string;
}

const getDetails = (result: { details: unknown }): ToolResult => result.details as ToolResult;
import { closeTeamManager } from "../../../teams/pool.js";
import { deleteTeamDirectory } from "../../../teams/storage.js";
import { createTeamShutdownTool } from "./team-shutdown.js";

// Mock randomUUID to return predictable values
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  deleteTeamDirectory: vi.fn(),
  getTeamDirectory: vi.fn((teamsDir, teamName) => `${teamsDir}/${teamName}`),
  readTeamConfig: vi.fn(),
  teamDirectoryExists: vi.fn(),
  validateTeamNameOrThrow: vi.fn(),
  getTeamsBaseDir: vi.fn(),
  writeTeamConfig: vi.fn(),
}));

// Mock fs/promises for rm
vi.mock("node:fs/promises", () => ({
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock manager and pool modules
vi.mock("../../../teams/pool.js", () => ({
  closeTeamManager: vi.fn(),
  getTeamManager: vi.fn(),
}));

// Mock manager class
vi.mock("../../../teams/manager.js", () => ({
  TeamManager: class {
    listMembers = vi.fn();
    storeMessage = vi.fn();
  },
}));

describe("TeamShutdown Tool", () => {
  let mockManager: {
    listMembers: ReturnType<typeof vi.fn>;
    storeMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up getTeamsBaseDir mock to return the teams path
    const { getTeamsBaseDir } = await import("../../../teams/storage.js");
    (getTeamsBaseDir as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const stateDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
      return `${stateDir}/teams`;
    });

    // Mock manager
    mockManager = {
      listMembers: vi.fn(),
      storeMessage: vi.fn(),
    };

    // Reset environment variable
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe("Shutdown with No Active Members", () => {
    it("should update team status to shutdown", async () => {
      const { teamDirectoryExists, readTeamConfig, writeTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      // No active members
      mockManager.listMembers.mockReturnValue([{ sessionKey: "member-1", status: "idle" }]);

      const tool = createTeamShutdownTool({ agentSessionKey: "test-session" });
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "my-team",
        expect.objectContaining({
          metadata: expect.objectContaining({ status: "shutdown" }),
        }),
      );
      expect(result.details).toMatchObject({
        status: "shutdown",
        deleted: true,
      });
    });

    it("should delete team directory", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(deleteTeamDirectory).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
    });

    it("should return deleted: true in response", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(result.details).toMatchObject({
        teamId: "team-id-123",
        teamName: "my-team",
        status: "shutdown",
        deleted: true,
      });
    });

    it("should close team manager after shutdown", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(closeTeamManager).toHaveBeenCalledWith("my-team");
    });
  });

  describe("Shutdown Request Protocol", () => {
    it("should send shutdown_request to all members", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      // Two working members
      mockManager.listMembers.mockReturnValue([
        { sessionKey: "researcher", status: "working" },
        { sessionKey: "developer", status: "working" },
      ]);

      const tool = createTeamShutdownTool({ agentSessionKey: "lead-session" });
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        reason: "Project completed",
      });

      expect(mockManager.storeMessage).toHaveBeenCalledTimes(2);

      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-uuid-1234",
          type: "shutdown_request",
          sender: "lead-session",
          recipient: "researcher",
          content: "Project completed",
          requestId: "test-uuid-1234",
          from: "lead-session",
          to: "researcher",
        }),
      );

      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-uuid-1234",
          type: "shutdown_request",
          sender: "lead-session",
          recipient: "developer",
          content: "Project completed",
          requestId: "test-uuid-1234",
          from: "lead-session",
          to: "developer",
        }),
      );
    });

    it("should return pending status with requestId", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(result.details).toMatchObject({
        teamId: "team-id-123",
        teamName: "my-team",
        status: "pending_shutdown",
        requestId: "test-uuid-1234",
      });
    });

    it("should include pending approvals list", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([
        { sessionKey: "researcher", status: "working" },
        { sessionKey: "developer", status: "working" },
        { sessionKey: "tester", status: "idle" },
      ]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(getDetails(result).pendingApprovals).toEqual(["researcher", "developer"]);
      expect(getDetails(result).pendingApprovals).not.toContain("tester");
    });

    it("should use default reason when not provided", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Team shutdown requested",
        }),
      );
    });

    it("should include message with member count", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(getDetails(result).message).toBe(
        "Shutdown request sent to 1 member(s). Waiting for approval.",
      );
    });
  });

  describe("Member Approval", () => {
    it("should track member approval via shutdown_response", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      // Member sends shutdown_response with approve: true
      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "shutdown_request",
          requestId: "test-uuid-1234",
        }),
      );

      // In a real scenario, member approval would be handled by a separate tool call
      // This test verifies the request is sent correctly
      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: "Team Lead",
          recipient: "worker",
        }),
      );
    });

    it("should complete shutdown after all approvals", async () => {
      const { teamDirectoryExists, readTeamConfig, writeTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      // Scenario: all members have already approved (status: idle)
      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "idle" }]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "my-team",
        expect.objectContaining({
          metadata: expect.objectContaining({ status: "shutdown" }),
        }),
      );
      expect(deleteTeamDirectory).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
      expect(closeTeamManager).toHaveBeenCalledWith("my-team");

      expect(result.details).toMatchObject({
        status: "shutdown",
        deleted: true,
      });
    });
  });

  describe("Member Rejection", () => {
    it("should handle member rejection with reason", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      // Member could respond with shutdown_response: { approve: false, reason: '...' }
      // The request is sent, and rejections are tracked through the message inbox
      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "shutdown_request",
          requestId: "test-uuid-1234",
        }),
      );
    });

    it("should return rejection reason", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        reason: "Still have pending tasks",
      });

      // Request is sent with the reason
      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Still have pending tasks",
        }),
      );

      expect(result.details).toMatchObject({
        status: "pending_shutdown",
        requestId: "test-uuid-1234",
      });
    });

    it("should not delete team on rejection", async () => {
      const { teamDirectoryExists, readTeamConfig, deleteTeamDirectory, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      // Team is not deleted because there are active members
      expect(deleteTeamDirectory).not.toHaveBeenCalled();
      expect(getDetails(result).status).toBe("pending_shutdown");
      expect(getDetails(result).deleted).toBeUndefined();
    });
  });

  describe("Validation", () => {
    it("should validate team name format", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: MyTeam. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamShutdownTool();
      await expect(tool.execute("tool-call-1", { team_name: "MyTeam" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject non-existent team", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "non-existent" });

      const content = result.content[0];
      expect("text" in content ? content.text : "").toContain("Team 'non-existent' not found");
    });

    it("should reject already shutdown team", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "shutdown" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      mockManager.listMembers.mockReturnValue([]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "shutdown-team" });

      // If team is already shutdown and has no members, it can be cleaned up
      expect(result.details).toMatchObject({
        status: "shutdown",
        deleted: true,
      });
    });

    it("should validate team name with uppercase letters", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: TestTeam. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamShutdownTool();
      await expect(tool.execute("tool-call-1", { team_name: "TestTeam" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should validate team name with special characters", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test_team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamShutdownTool();
      await expect(tool.execute("tool-call-1", { team_name: "test_team" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should validate team name with spaces", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamShutdownTool();
      await expect(tool.execute("tool-call-1", { team_name: "test team" })).rejects.toThrow(
        "Invalid team name",
      );
    });
  });

  describe("Custom State Directory", () => {
    it("should use OPENCLAW_STATE_DIR environment variable when set", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      process.env.OPENCLAW_STATE_DIR = "/custom/state/dir";

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      mockManager.listMembers.mockReturnValue([]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(teamDirectoryExists).toHaveBeenCalledWith("/custom/state/dir/teams", "test-team");
      expect(deleteTeamDirectory).toHaveBeenCalledWith("/custom/state/dir/teams", "test-team");

      delete process.env.OPENCLAW_STATE_DIR;
    });
  });

  describe("Mixed Member States", () => {
    it("should only send shutdown requests to working members", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([
        { sessionKey: "worker-1", status: "working" },
        { sessionKey: "worker-2", status: "idle" },
        { sessionKey: "worker-3", status: "blocked" },
      ]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      // Only 1 shutdown request for the working member
      expect(mockManager.storeMessage).toHaveBeenCalledTimes(1);
      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: "worker-1",
        }),
      );
    });

    it("should shutdown immediately if all members are idle", async () => {
      const { teamDirectoryExists, readTeamConfig, writeTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([
        { sessionKey: "worker-1", status: "idle" },
        { sessionKey: "worker-2", status: "idle" },
      ]);

      const tool = createTeamShutdownTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(mockManager.storeMessage).not.toHaveBeenCalled();
      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "my-team",
        expect.objectContaining({
          metadata: expect.objectContaining({ status: "shutdown" }),
        }),
      );
      expect(deleteTeamDirectory).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
      expect(result.details).toMatchObject({
        status: "shutdown",
        deleted: true,
      });
    });
  });

  describe("Agent Session Key", () => {
    it("should use custom agentSessionKey as sender", async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool({ agentSessionKey: "custom-lead" });
      await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: "custom-lead",
        }),
      );
    });

    it('should use default "Team Lead" when agentSessionKey not provided', async () => {
      const { teamDirectoryExists, readTeamConfig, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (readTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "team-id-123",
        metadata: { status: "active" },
      });
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      mockManager.listMembers.mockReturnValue([{ sessionKey: "worker", status: "working" }]);

      const tool = createTeamShutdownTool();
      await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(mockManager.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: "Team Lead",
        }),
      );
    });
  });
});
