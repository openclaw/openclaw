/**
 * TeamCreate Tool Tests
 * Tests for creating teams with proper validation and setup
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper type for tool results
interface ToolResult {
  teamName?: string;
  teamId?: string;
  status?: string;
  error?: string;
  message?: string;
  warnings?: string[];
  teamDir?: string;
}

const getDetails = (result: { details: unknown }): ToolResult => result.details as ToolResult;
import { createTeamCreateTool } from "./team-create.js";

// Mock randomUUID to return predictable values
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

// Mock storage modules
vi.mock("../../../teams/storage.js", () => ({
  createTeamDirectory: vi.fn(),
  readTeamConfig: vi.fn(),
  teamDirectoryExists: vi.fn(),
  validateTeamNameOrThrow: vi.fn(),
  getTeamsBaseDir: vi.fn(() => {
    const stateDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
    return `${stateDir}/teams`;
  }),
  writeTeamConfig: vi.fn(),
}));

// Mock manager and pool modules
vi.mock("../../../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
}));

vi.mock("../../../teams/manager.js", () => ({
  TeamManager: class {
    addMember = vi.fn().mockResolvedValue({
      sessionKey: "test-lead",
      agentId: "general-purpose",
      name: "Test Lead",
      agentType: "lead",
      status: "idle",
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

describe("TeamCreate Tool", () => {
  let mockManager: {
    addMember: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock manager
    mockManager = {
      addMember: vi.fn().mockResolvedValue({
        sessionKey: "test-lead",
        agentId: "general-purpose",
        name: "Test Lead",
        agentType: "lead",
        status: "idle",
      }),
    };

    // Reset environment variable
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe("Successful Team Creation", () => {
    it("should create team with all required fields and return success response", async () => {
      const { teamDirectoryExists, createTeamDirectory, writeTeamConfig } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool({ agentSessionKey: "test-session" });
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("my-team");
      expect(teamDirectoryExists).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
      expect(createTeamDirectory).toHaveBeenCalledWith(`${process.cwd()}/teams`, "my-team");
      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "my-team",
        expect.objectContaining({
          team_name: "my-team",
          id: "test-uuid-1234",
          agent_type: "general-purpose",
          lead: "test-session",
        }),
      );
      expect(getTeamManager).toHaveBeenCalledWith("my-team", `${process.cwd()}/teams`);
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "test-session",
          agentId: "general-purpose",
          agentType: "lead",
          status: "idle",
        }),
      );

      const details = getDetails(result);
      expect(details.teamId).toBe("test-uuid-1234");
      expect(details.teamName).toBe("my-team");
      expect(details.status).toBe("active");
      expect(details.message).toContain("Team");
      expect(details.message).toContain("my-team");
      expect(details.message).toContain("test-uuid-1234");
    });

    it("should create team directory structure with tasks, messages, and inbox subdirectories", async () => {
      const { teamDirectoryExists, createTeamDirectory } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(createTeamDirectory).toHaveBeenCalledWith(`${process.cwd()}/teams`, "test-team");
    });

    it("should initialize SQLite ledger through team manager", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(getTeamManager).toHaveBeenCalledWith("test-team", `${process.cwd()}/teams`);
    });

    it("should add team lead as member with correct role", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool({ agentSessionKey: "lead-session-key" });
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "lead-session-key",
          agentId: "general-purpose",
          agentType: "lead",
          status: "idle",
        }),
      );
    });

    it("should return team ID and status in response", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team" });

      expect(result.details).toMatchObject({
        teamId: expect.any(String),
        teamName: "my-team",
        status: "active",
        message: expect.stringContaining("created successfully"),
      });
    });
  });

  describe("Custom Agent Type Handling", () => {
    it("should store custom agent_type in config when provided", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool({ agentSessionKey: "test-session" });
      await tool.execute("tool-call-1", {
        team_name: "research-team",
        agent_type: "researcher",
      });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "research-team",
        expect.objectContaining({
          agent_type: "researcher",
        }),
      );
    });

    it("should use default agent_type when not specified", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "test-team",
        expect.objectContaining({
          agent_type: "general-purpose",
        }),
      );
    });

    it("should use custom agent_type for team lead member", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", {
        team_name: "dev-team",
        agent_type: "developer",
      });

      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "developer",
        }),
      );
    });
  });

  describe("Description Metadata", () => {
    it("should store description in config when provided", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const description = "A team for building user interfaces";
      await tool.execute("tool-call-1", {
        team_name: "ui-team",
        description,
      });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "ui-team",
        expect.objectContaining({
          description,
        }),
      );
    });

    it("should use empty string for description when not provided", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      const writeConfigCall = (writeTeamConfig as ReturnType<typeof vi.fn>).mock.calls[0];
      const config = writeConfigCall[2] as Record<string, unknown>;
      expect(config.description).toBe("");
    });

    it("should handle long description text", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const longDescription = "a".repeat(500);
      await tool.execute("tool-call-1", {
        team_name: "test-team",
        description: longDescription,
      });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "test-team",
        expect.objectContaining({
          description: longDescription,
        }),
      );
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

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "MyTeam" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject invalid team name format (special characters)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: my_team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "my_team" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject invalid team name format (spaces)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: my team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "my team" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject invalid team name format (underscores)", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test_team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test_team" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject team names with path traversal attempts", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: ../evil. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "../evil" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject team names with null bytes", async () => {
      const { validateTeamNameOrThrow } = await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          "Invalid team name: test\x00team. Must contain only lowercase letters, numbers, and hyphens",
        );
      });

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test\x00team" })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject empty team name", async () => {
      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "" })).rejects.toThrow(
        "team_name required",
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

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: longName })).rejects.toThrow(
        "Invalid team name",
      );
    });

    it("should reject duplicate team names", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "existing-team" });

      const content = result.content[0];
      expect("text" in content ? content.text : "").toContain(
        "Team 'existing-team' already exists",
      );
      expect("text" in content ? content.text : "").toContain("choose a different name");
    });

    it("should accept valid team names with only lowercase letters", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "myteam" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("myteam");
      expect(getDetails(result).status).toBe("active");
    });

    it("should accept valid team names with numbers", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "team123" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("team123");
      expect(getDetails(result).status).toBe("active");
    });

    it("should accept valid team names with hyphens", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "my-team-name" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("my-team-name");
      expect(getDetails(result).status).toBe("active");
    });

    it("should accept valid team names with mixed lowercase, numbers, and hyphens", async () => {
      const { teamDirectoryExists, validateTeamNameOrThrow } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "team-v2-123" });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith("team-v2-123");
      expect(getDetails(result).status).toBe("active");
    });
  });

  describe("Error Handling", () => {
    it("should handle file system errors when creating directory", async () => {
      const { teamDirectoryExists, createTeamDirectory } =
        await import("../../../teams/storage.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (createTeamDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("EACCES: permission denied"),
      );

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test-team" })).rejects.toThrow(
        "permission denied",
      );
    });

    it("should handle file system errors when writing config", async () => {
      const { teamDirectoryExists, createTeamDirectory, writeTeamConfig } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (createTeamDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (writeTeamConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOSPC: no space left on device"),
      );
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test-team" })).rejects.toThrow(
        "ENOSPC",
      );
    });

    it("should handle database errors when adding team lead member", async () => {
      const { teamDirectoryExists, createTeamDirectory, writeTeamConfig } =
        await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (createTeamDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (writeTeamConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      mockManager.addMember.mockRejectedValue(
        new Error("SQLITE_CORRUPT: database disk image is malformed"),
      );
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test-team" })).rejects.toThrow(
        "SQLITE_CORRUPT",
      );
    });

    it("should handle errors from teamDirectoryExists check", async () => {
      const { teamDirectoryExists } = await import("../../../teams/storage.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("EBUSY: resource busy or locked"),
      );

      const tool = createTeamCreateTool();
      await expect(tool.execute("tool-call-1", { team_name: "test-team" })).rejects.toThrow(
        "EBUSY",
      );
    });

    it("should use OPENCLAW_STATE_DIR environment variable when set", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      process.env.OPENCLAW_STATE_DIR = "/custom/state/dir";

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(teamDirectoryExists).toHaveBeenCalledWith("/custom/state/dir/teams", "test-team");
      expect(writeTeamConfig).toHaveBeenCalledWith(
        "/custom/state/dir/teams",
        "test-team",
        expect.anything(),
      );
      expect(getTeamManager).toHaveBeenCalledWith("test-team", "/custom/state/dir/teams");

      delete process.env.OPENCLAW_STATE_DIR;
    });

    it("should use unknown as default lead when agentSessionKey not provided", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "test-team",
        expect.objectContaining({
          lead: "unknown",
        }),
      );
    });

    it("should use custom agentSessionKey when provided in options", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool({ agentSessionKey: "custom-session-123" });
      await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(writeTeamConfig).toHaveBeenCalledWith(
        `${process.cwd()}/teams`,
        "test-team",
        expect.objectContaining({
          lead: "custom-session-123",
        }),
      );
      expect(mockManager.addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "custom-session-123",
        }),
      );
    });
  });

  describe("Team Configuration Structure", () => {
    it("should create config with correct metadata fields", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool({ agentSessionKey: "test-session" });
      await tool.execute("tool-call-1", { team_name: "test-team" });

      const writeConfigCall = (writeTeamConfig as ReturnType<typeof vi.fn>).mock.calls[0];
      const config = writeConfigCall[2] as Record<string, unknown>;

      expect(config).toHaveProperty("team_name", "test-team");
      expect(config).toHaveProperty("id", "test-uuid-1234");
      expect(config).toHaveProperty("description", "");
      expect(config).toHaveProperty("agent_type", "general-purpose");
      expect(config).toHaveProperty("lead", "test-session");
      expect(config).toHaveProperty("metadata");
      expect(config.metadata as Record<string, unknown>).toHaveProperty("createdAt");
      expect(config.metadata as Record<string, unknown>).toHaveProperty("updatedAt");
      expect(config.metadata as Record<string, unknown>).toHaveProperty("status", "active");
    });

    it("should set createdAt and updatedAt to current timestamp", async () => {
      const { teamDirectoryExists, writeTeamConfig } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      const beforeTimestamp = Date.now();

      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      await tool.execute("tool-call-1", { team_name: "test-team" });

      const afterTimestamp = Date.now();

      const writeConfigCall = (writeTeamConfig as ReturnType<typeof vi.fn>).mock.calls[0];
      const config = writeConfigCall[2] as Record<string, unknown>;
      const metadata = config.metadata as Record<string, unknown>;

      expect(metadata.createdAt).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(metadata.createdAt).toBeLessThanOrEqual(afterTimestamp);
      expect(metadata.updatedAt).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(metadata.updatedAt).toBeLessThanOrEqual(afterTimestamp);
    });
  });

  describe("agentToAgent Policy Warnings", () => {
    it("should warn when agentToAgent is disabled", async () => {
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
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(getDetails(result).warnings).toBeDefined();
      expect(getDetails(result).warnings).toHaveLength(1);
      expect(getDetails(result).warnings![0]).toContain("tools.agentToAgent is not enabled");
      expect(getDetails(result).message).toContain("WARNING");
    });

    it("should warn when agentToAgent.allow does not include wildcard", async () => {
      const { loadConfig } = await import("../../../config/config.js");
      const { teamDirectoryExists } = await import("../../../teams/storage.js");
      const { getTeamManager } = await import("../../../teams/pool.js");

      (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["main"],
          },
        },
      });
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(getDetails(result).warnings).toBeDefined();
      expect(getDetails(result).warnings).toHaveLength(1);
      expect(getDetails(result).warnings![0]).toContain(
        "tools.agentToAgent.allow does not include '*'",
      );
    });

    it("should not warn when agentToAgent is enabled with wildcard", async () => {
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
      (teamDirectoryExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (getTeamManager as ReturnType<typeof vi.fn>).mockReturnValue(mockManager);

      const tool = createTeamCreateTool();
      const result = await tool.execute("tool-call-1", { team_name: "test-team" });

      expect(getDetails(result).warnings).toBeUndefined();
      expect(getDetails(result).message).not.toContain("WARNING");
    });
  });
});
