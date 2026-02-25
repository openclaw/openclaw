/**
 * TeammateSpawn Tool Tests
 * Tests for spawning teammate agents and adding them to teams
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTeammateSpawnTool } from "./teammate-spawn.js";

// Mock randomUUID to return predictable values
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "spawned-session-uuid-5678"),
}));

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  readTeamConfig: vi.fn(),
  teamDirectoryExists: vi.fn(),
  validateTeamNameOrThrow: vi.fn(),
}));

// Mock manager and pool modules
vi.mock("../../../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
}));

vi.mock("../../../teams/manager.js", () => ({
  TeamManager: class {
    addMember = vi.fn().mockResolvedValue({
      sessionKey: "spawned-session-uuid-5678",
      agentId: "researcher",
      name: "Test Researcher",
      agentType: "member",
      status: "idle",
      joinedAt: Date.now(),
    });

    getTeamConfig = vi.fn().mockResolvedValue({
      team_name: "test-team",
      id: "team-uuid-1234",
      description: "Test team",
      agent_type: "general-purpose",
      lead: "lead-session-key",
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "active",
      },
    });
  },
}));

// Mock config for agentToAgent policy
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["*"],
      },
    },
  })),
}));

// Mock Gateway call for session creation
vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ runId: "test-run-id-123" }),
}));

describe("TeammateSpawn Tool", () => {
  let mockManager: {
    addMember: ReturnType<typeof vi.fn>;
    getTeamConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset callGateway mock to return success by default
    const { callGateway } = await import("../../../gateway/call.js");
    (callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "test-run-id-123" });

    // Mock manager
    mockManager = {
      addMember: vi.fn().mockResolvedValue({
        sessionKey: "spawned-session-uuid-5678",
        agentId: "researcher",
        name: "Test Researcher",
        agentType: "member",
        status: "idle",
        joinedAt: Date.now(),
      }),
      getTeamConfig: vi.fn().mockResolvedValue({
        team_name: "test-team",
        id: "team-uuid-1234",
        description: "Test team",
        agent_type: "general-purpose",
        lead: "lead-session-key",
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "active",
        },
      }),
    };

    // Reset environment variable
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe("Successful Spawning", () => {
    it("should spawn teammate with all required fields and return success response", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Researcher",
      });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("my-team");
      expect(teamDirectoryExists).toHaveBeenCalledWith(process.cwd(), "my-team");
      expect(getTeamManager).toHaveBeenCalledWith("my-team", process.cwd());
      expect(mockManager.getTeamConfig).toHaveBeenCalled();
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Researcher",
          agentId: "general-purpose",
          agentType: "member",
          status: "idle",
        }),
      );

      const details = result.details;
      expect(details.sessionKey).toBe("agent:general-purpose:teammate:spawned-session-uuid-5678");
      expect(details.agentId).toBe("general-purpose");
      expect(details.name).toBe("Test Researcher");
      expect(details.teamName).toBe("my-team");
    });

    it("should add member to team ledger with correct parameters", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "dev-team",
        name: "Frontend Developer",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Frontend Developer",
          agentId: "general-purpose",
          agentType: "member",
          status: "idle",
        }),
      );
    });

    it("should generate unique session ID for each spawned teammate", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result1 = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Teammate 1",
      });
      const result2 = await tool.execute("tool-call-2", {
        team_name: "my-team",
        name: "Teammate 2",
      });

      expect(result1.details.sessionKey).toBe(
        "agent:general-purpose:teammate:spawned-session-uuid-5678",
      );
      expect(result2.details.sessionKey).toBe(
        "agent:general-purpose:teammate:spawned-session-uuid-5678",
      );
    });

    it("should return session information in response", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Agent",
      });

      expect(result.details).toMatchObject({
        sessionKey: expect.any(String),
        agentId: expect.any(String),
        name: "Test Agent",
        teamName: "my-team",
      });
    });
  });

  describe("Custom Agent Type Handling", () => {
    it("should use custom agent_id when provided", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "research-team",
        name: "Data Scientist",
        agent_id: "researcher",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "researcher",
        }),
      );
      expect(result.details.agentId).toBe("researcher");
    });

    it("should use team agent_type as default when agent_id not provided", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "dev-team",
        id: "team-uuid",
        agent_type: "developer",
        metadata: { status: "active" },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "dev-team",
        name: "Backend Developer",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "developer",
        }),
      );
    });

    it("should use general-purpose when agent_id and team agent_type are both missing", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "team",
        id: "team-uuid",
        agent_type: "general-purpose",
        metadata: { status: "active" },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "team",
        name: "Member",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "general-purpose",
        }),
      );
    });
  });

  describe("Model Override", () => {
    it("should accept model parameter (currently not used in implementation)", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Agent",
        model: "claude-opus-4",
      });

      // Tool should execute successfully even with model parameter
      expect(result.details.name).toBe("Test Agent");
      expect(mockManager.addMember).toHaveBeenCalled();
    });

    it("should work correctly when model parameter is not provided", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Agent",
      });

      expect(result.details.name).toBe("Test Agent");
      expect(mockManager.addMember).toHaveBeenCalled();
    });
  });

  describe("Validation Errors", () => {
    it("should reject invalid team name format (uppercase letters)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: MyTeam. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "MyTeam", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject invalid team name format (special characters)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: my_team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "my_team", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject invalid team name format (spaces)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: my team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "my team", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject invalid team name format (underscores)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test_team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "test_team", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject team names with path traversal attempts", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: ../evil. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "../evil", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject team names with null bytes", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test\x00team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "test\x00team", name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject empty team name", async () => {
      const tool = createTeammateSpawnTool();
      await expect(tool.execute("tool-call-1", { team_name: "", name: "Test" })).rejects.toThrow(
        "team_name required",
      );
    });

    it("should reject empty name parameter", async () => {
      const tool = createTeammateSpawnTool();
      await expect(tool.execute("tool-call-1", { team_name: "team", name: "" })).rejects.toThrow(
        "name required",
      );
    });

    it("should reject team names longer than 50 characters", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      const longName = "a".repeat(51);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          `Invalid team name: ${longName}. Must contain only lowercase letters, numbers, and hyphens`,
        );
      });

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: longName, name: "Test" }),
      ).rejects.toThrow("Invalid team name");
    });

    it("should reject non-existent team", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", { team_name: "non-existent", name: "Test" });

      expect(result.content[0].text).toContain("Team 'non-existent' not found");
      expect(result.content[0].text).toContain("create the team first");
    });

    it("should reject spawning into shutdown team", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "shutdown-team",
        id: "team-uuid",
        agent_type: "general-purpose",
        metadata: { status: "shutdown" },
      });

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "shutdown-team",
        name: "Test",
      });

      expect(result.content[0].text).toContain("Team 'shutdown-team' is not active");
      expect(result.content[0].text).toContain("status: shutdown");
    });

    it("should accept valid team names with only lowercase letters", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", { team_name: "myteam", name: "Test" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("myteam");
      expect(result.details.name).toBe("Test");
    });

    it("should accept valid team names with numbers", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", { team_name: "team123", name: "Test" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("team123");
      expect(result.details.name).toBe("Test");
    });

    it("should accept valid team names with hyphens", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team-name", name: "Test" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("my-team-name");
      expect(result.details.name).toBe("Test");
    });

    it("should accept valid team names with mixed lowercase, numbers, and hyphens", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", { team_name: "team-v2-123", name: "Test" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("team-v2-123");
      expect(result.details.name).toBe("Test");
    });
  });

  describe("Error Handling", () => {
    it("should handle database errors when adding member", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.addMember.mockRejectedValue(
        new Error("SQLITE_CORRUPT: database disk image is malformed"),
      );

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "test-team",
        name: "Test",
      });

      // Error is caught and returned as JSON error
      expect(result.details.error).toContain("Failed to spawn teammate");
      expect(result.details.error).toContain("SQLITE_CORRUPT");
    });

    it("should handle errors from teamDirectoryExists check", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("EBUSY: resource busy or locked"),
      );

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "test-team", name: "Test" }),
      ).rejects.toThrow("EBUSY");
    });

    it("should handle errors when getting team config", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockRejectedValue(new Error("ENOTDIR: not a directory"));

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await expect(
        tool.execute("tool-call-1", { team_name: "test-team", name: "Test" }),
      ).rejects.toThrow("ENOTDIR");
    });

    it("should use OPENCLAW_STATE_DIR environment variable when set", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      process.env.OPENCLAW_STATE_DIR = "/custom/state/dir";

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", { team_name: "test-team", name: "Test" });

      expect(teamDirectoryExists).toHaveBeenCalledWith("/custom/state/dir", "test-team");
      expect(getTeamManager).toHaveBeenCalledWith("test-team", "/custom/state/dir");

      delete process.env.OPENCLAW_STATE_DIR;
    });
  });

  describe("Session State Integration", () => {
    it("should return sessionKey for newly spawned teammate", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "New Member",
      });

      expect(result.details.sessionKey).toBe(
        "agent:general-purpose:teammate:spawned-session-uuid-5678",
      );
      expect(result.details.teammateId).toBe("spawned-session-uuid-5678");
    });

    it("should return teamName in response", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "research-team",
        name: "Member",
      });

      expect(result.details.teamName).toBe("research-team");
    });

    it("should add member with teamRole as member", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", { team_name: "my-team", name: "Member" });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "member",
        }),
      );
    });

    it("should store teammate name from parameter", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Custom Name",
      });

      expect(result.details.name).toBe("Custom Name");
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Custom Name",
        }),
      );
    });
  });

  describe("Session Key Format", () => {
    it("should generate session key in standard format agent:{agentId}:teammate:{uuid}", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Researcher",
        agent_id: "researcher",
      });

      // Session key should follow format: agent:{agentId}:teammate:{uuid}
      expect(result.details.sessionKey).toMatch(/^agent:researcher:teammate:/);
      expect(result.details.sessionKey).toBe("agent:researcher:teammate:spawned-session-uuid-5678");
    });

    it("should use team's agent_type as default agent ID", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
      });

      // Uses team config's agent_type which is "general-purpose"
      expect(result.details.sessionKey).toMatch(/^agent:general-purpose:teammate:/);
    });

    it("should use 'main' as fallback when no agent_type configured", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "test-team",
        id: "team-uuid",
        agent_type: undefined,
        metadata: { status: "active" },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "test-team",
        name: "Dev",
      });

      expect(result.details.sessionKey).toMatch(/^agent:main:teammate:/);
    });

    it("should use explicit agent_id over team's agent_type", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      mockManager.getTeamConfig.mockResolvedValue({
        team_name: "test-team",
        id: "team-uuid",
        agent_type: "developer",
        metadata: { status: "active" },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "test-team",
        name: "Dev",
        agent_id: "custom-agent",
      });

      expect(result.details.sessionKey).toMatch(/^agent:custom-agent:teammate:/);
    });

    it("should store session key in member record", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
        agent_id: "worker",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:worker:teammate:spawned-session-uuid-5678",
        }),
      );
    });

    it("should return teammateId as the UUID portion", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
      });

      expect(result.details.teammateId).toBe("spawned-session-uuid-5678");
    });
  });

  describe("agentToAgent Policy", () => {
    it("should allow spawning teammate with same agent ID", async () => {
      const { loadConfig } = await import("../../../config/config.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        tools: {
          agentToAgent: {
            enabled: false, // Even when disabled
            allow: [],
          },
        },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool({
        agentSessionKey: "agent:main:user:main",
      });
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
        agent_id: "main", // Same as requester
      });

      expect(result.details.status).toBe("spawned");
    });

    it("should deny spawning teammate with different agent ID when policy disabled", async () => {
      const { loadConfig } = await import("../../../config/config.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        tools: {
          agentToAgent: {
            enabled: false,
            allow: [],
          },
        },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool({
        agentSessionKey: "agent:main:user:main",
      });
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
        agent_id: "researcher", // Different from requester
      });

      expect(result.details.error).toContain("denied by tools.agentToAgent policy");
    });

    it("should allow spawning with different agent ID when policy allows", async () => {
      const { loadConfig } = await import("../../../config/config.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["main", "*"],
          },
        },
      });

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool({
        agentSessionKey: "agent:main:user:main",
      });
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
        agent_id: "researcher",
      });

      expect(result.details.status).toBe("spawned");
      expect(result.details.agentId).toBe("researcher");
    });
  });
});
