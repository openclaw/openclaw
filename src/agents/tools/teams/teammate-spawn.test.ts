/**
 * TeammateSpawn Tool Tests
 * Tests for spawning teammate agents and adding them to teams
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper type for tool results
interface ToolResult {
  teammateId?: string;
  sessionKey?: string;
  status?: string;
  error?: string;
  teamName?: string;
  agentId?: string;
  role?: string;
  name?: string;
  runId?: string;
  message?: string;
}

const getDetails = (result: { details: unknown }): ToolResult => result.details as ToolResult;
import { createTeammateSpawnTool } from "./teammate-spawn.js";

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  readTeamConfig: vi.fn(),
  teamDirectoryExists: vi.fn(),
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

vi.mock("../../../teams/manager.js", () => ({
  TeamManager: class {
    addMember = vi.fn().mockResolvedValue({
      sessionKey: "agent:teammate-test-researcher:main",
      agentId: "teammate-test-researcher",
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

// Mock Gateway call for session creation
vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ runId: "test-run-id-123" }),
}));

// Mock fs/promises for mkdir
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
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
        sessionKey: "agent:teammate-test-researcher:main",
        agentId: "teammate-test-researcher",
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
      expect(teamDirectoryExists).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
      expect(getTeamManager).toHaveBeenCalledWith("my-team", `${process.cwd()}/teams`);
      expect(mockManager.getTeamConfig).toHaveBeenCalled();
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Researcher",
          agentId: "teammate-test-researcher",
          agentType: "member",
          status: "idle",
        }),
      );

      const details = getDetails(result);
      expect(details.sessionKey).toBe("agent:teammate-test-researcher:main");
      expect(details.agentId).toBe("teammate-test-researcher");
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
          agentId: "teammate-frontend-developer",
          agentType: "member",
          status: "idle",
        }),
      );
    });

    it("should generate unique session keys for each spawned teammate", async () => {
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

      // Each teammate gets a unique session key based on their name
      expect(getDetails(result1).sessionKey).toBe("agent:teammate-teammate-1:main");
      expect(getDetails(result2).sessionKey).toBe("agent:teammate-teammate-2:main");
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

    it("should create agent directory for teammate", async () => {
      const { mkdir } = await import("node:fs/promises");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Agent",
      });

      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining("my-team/agents/test-agent/agent"),
        { recursive: true },
      );
    });
  });

  describe("Name Sanitization", () => {
    it("should sanitize teammate name for use in agent ID", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Researcher!",
      });

      // Name should be sanitized (lowercase, special chars replaced)
      expect(getDetails(result).agentId).toBe("teammate-test-researcher");
      expect(getDetails(result).sessionKey).toBe("agent:teammate-test-researcher:main");
    });

    it("should handle spaces in name", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Frontend Developer",
      });

      expect(getDetails(result).agentId).toBe("teammate-frontend-developer");
    });

    it("should handle uppercase letters in name", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "RESEARCHER",
      });

      expect(getDetails(result).agentId).toBe("teammate-researcher");
    });
  });

  describe("Model Override", () => {
    it("should accept model parameter and pass to sessions.patch", async () => {
      const { callGateway } = await import("../../../gateway/call.js");
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

      // sessions.patch should be called with model
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.patch",
          params: expect.objectContaining({ model: "claude-opus-4" }),
        }),
      );

      // Tool should execute successfully
      expect(getDetails(result).name).toBe("Test Agent");
      expect(mockManager.addMember).toHaveBeenCalled();
    });

    it("should work correctly when model parameter is not provided", async () => {
      const { callGateway } = await import("../../../gateway/call.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Test Agent",
      });

      // sessions.patch should NOT be called without model
      expect(callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.patch" }),
      );

      expect(getDetails(result).name).toBe("Test Agent");
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

      const content = result.content[0];
      expect("text" in content ? content.text : "").toContain("Team 'non-existent' not found");
      expect("text" in content ? content.text : "").toContain("create the team first");
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

      const content = result.content[0];
      expect("text" in content ? content.text : "").toContain("Team 'shutdown-team' is not active");
      expect("text" in content ? content.text : "").toContain("status: shutdown");
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
      expect(getDetails(result).name).toBe("Test");
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
      expect(getDetails(result).name).toBe("Test");
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
      expect(getDetails(result).name).toBe("Test");
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
      expect(getDetails(result).name).toBe("Test");
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
      expect(getDetails(result).error).toContain("Failed to spawn teammate");
      expect(getDetails(result).error).toContain("SQLITE_CORRUPT");
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

      expect(teamDirectoryExists).toHaveBeenCalledWith("/custom/state/dir/teams", "test-team");
      expect(getTeamManager).toHaveBeenCalledWith("test-team", "/custom/state/dir/teams");

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

      expect(getDetails(result).sessionKey).toBe("agent:teammate-new-member:main");
      expect(getDetails(result).teammateId).toBe("new-member");
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

      expect(getDetails(result).teamName).toBe("research-team");
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

      expect(getDetails(result).name).toBe("Custom Name");
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Custom Name",
        }),
      );
    });
  });

  describe("Session Key Format", () => {
    it("should generate session key in format agent:teammate-{name}:main", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Researcher",
      });

      // Session key should follow format: agent:teammate-{name}:main
      expect(getDetails(result).sessionKey).toBe("agent:teammate-researcher:main");
    });

    it("should use sanitized name in agent ID", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Data Scientist",
      });

      // Name is sanitized to "data-scientist"
      expect(getDetails(result).agentId).toBe("teammate-data-scientist");
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
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:teammate-worker:main",
        }),
      );
    });

    it("should return teammateId as the sanitized name", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      const result = await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
      });

      expect(getDetails(result).teammateId).toBe("worker");
    });
  });

  describe("Lane Selection", () => {
    it("should use AGENT_LANE_TEAMMATE for spawning", async () => {
      const { callGateway } = await import("../../../gateway/call.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeammateSpawnTool();
      await tool.execute("tool-call-1", {
        team_name: "my-team",
        name: "Worker",
      });

      // Verify agent call uses the teammate lane
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            lane: "teammate",
          }),
        }),
      );
    });
  });
});
