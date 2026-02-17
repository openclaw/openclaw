import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, PaginatedResult } from "../ai-fabric/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { CLOUDRU_MCP_CONFIG_FILENAME } from "./write-mcp-config.js";

// Mock the simple client
const mockListMcpServers = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue({ items: [], total: 0 });
vi.mock("../ai-fabric/cloudru-client-simple.js", () => ({
  CloudruSimpleClient: class {
    listMcpServers = mockListMcpServers;
    listAgents = mockListAgents;
  },
}));

// Import after mocks
const { setupAiFabric, setupAiFabricNonInteractive } = await import("./setup-ai-fabric.js");

const SAMPLE_SERVERS: McpServer[] = [
  {
    id: "mcp-1",
    name: "web-search",
    status: "RUNNING",
    tools: [{ name: "search", description: "Web search" }],
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "mcp-2",
    name: "code-runner",
    status: "AVAILABLE",
    tools: [
      { name: "run", description: "Run code" },
      { name: "lint", description: "Lint code" },
    ],
    createdAt: "2026-01-02T00:00:00Z",
  },
];

function createMockPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn().mockResolvedValue([]),
    text: vi.fn().mockResolvedValue(""),
    confirm: vi.fn().mockResolvedValue(false),
    progress: vi.fn().mockReturnValue({ update: vi.fn(), stop: vi.fn() }),
    ...overrides,
  };
}

const BASE_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "claude",
          env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8082" },
        },
      },
    },
  },
};

describe("setupAiFabric (interactive)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-ai-fabric-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips when user declines", async () => {
    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(false),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config).toBe(BASE_CONFIG);
  });

  it("configures with selected MCP servers", async () => {
    mockListMcpServers.mockResolvedValue({ items: SAMPLE_SERVERS, total: 2 });

    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-abc"),
      multiselect: vi.fn().mockResolvedValue(SAMPLE_SERVERS),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.enabled).toBe(true);
    expect(result.config.aiFabric?.projectId).toBe("proj-abc");

    // Check MCP config file was written
    const mcpConfigPath = path.join(tmpDir, CLOUDRU_MCP_CONFIG_FILENAME);
    const content = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
    expect(content.mcpServers["web-search"].url).toBe("https://ai-agents.api.cloud.ru/mcp/mcp-1");

    // Check CLI backend args include --mcp-config
    const cliBackend = result.config.agents?.defaults?.cliBackends?.["claude-cli"];
    expect((cliBackend as Record<string, unknown>).args).toContain("--mcp-config");
    expect((cliBackend as Record<string, unknown>).args).toContain("--strict-mcp-config");
  });

  it("handles 0 MCP servers gracefully", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });

    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-empty"),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-empty");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("No MCP servers found"),
      "AI Fabric",
    );
  });

  it("handles API error gracefully", async () => {
    mockListMcpServers.mockRejectedValue(new Error("Network error"));

    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-fail"),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Could not list MCP servers"),
      "AI Fabric warning",
    );
  });

  it("handles user selecting no servers", async () => {
    mockListMcpServers.mockResolvedValue({ items: SAMPLE_SERVERS, total: 2 });

    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-skip"),
      multiselect: vi.fn().mockResolvedValue([]),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-skip");
  });
});

describe("setupAiFabricNonInteractive", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-ai-fabric-ni-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-connects running/available MCP servers", async () => {
    const servers: McpServer[] = [
      ...SAMPLE_SERVERS,
      {
        id: "mcp-3",
        name: "stopped-server",
        status: "SUSPENDED",
        tools: [],
        createdAt: "2026-01-03T00:00:00Z",
      },
    ];
    mockListMcpServers.mockResolvedValue({
      items: servers,
      total: 3,
    } satisfies PaginatedResult<McpServer>);

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-ni",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.projectId).toBe("proj-ni");

    // Only RUNNING + AVAILABLE servers should be in config (not SUSPENDED)
    const mcpConfigPath = path.join(tmpDir, CLOUDRU_MCP_CONFIG_FILENAME);
    const content = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
    expect(Object.keys(content.mcpServers)).toHaveLength(2);
    expect(content.mcpServers["stopped-server"]).toBeUndefined();
  });

  it("returns configured=false on API error", async () => {
    mockListMcpServers.mockRejectedValue(new Error("Connection refused"));

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-fail",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-fail");
  });

  it("returns configured=false when no servers available", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-empty",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-empty");
  });
});
