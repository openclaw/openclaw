import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, McpServer, PaginatedResult } from "../ai-fabric/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AiFabricAgentEntry } from "../config/types.ai-fabric.js";
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

const SAMPLE_AGENTS: Agent[] = [
  {
    id: "agent-1",
    name: "code-assistant",
    status: "RUNNING",
    endpoint: "https://agent-1.example.com",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "agent-2",
    name: "search-agent",
    status: "RUNNING",
    endpoint: "https://agent-2.example.com",
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  },
];

const EXPECTED_AGENT_ENTRIES: AiFabricAgentEntry[] = [
  { id: "agent-1", name: "code-assistant", endpoint: "https://agent-1.example.com" },
  { id: "agent-2", name: "search-agent", endpoint: "https://agent-2.example.com" },
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

  it("shows ENOTFOUND detail instead of 'TypeError: fetch failed'", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.cloud.ru"), {
      code: "ENOTFOUND",
    });
    mockListMcpServers.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const noteMock = vi.fn();
    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-dns-fail"),
      note: noteMock,
    });

    await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    const noteCall = noteMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("Could not list MCP"),
    );
    expect(noteCall).toBeDefined();
    expect(noteCall![0]).toContain("ENOTFOUND");
    expect(noteCall![0]).not.toContain("TypeError: fetch failed");
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

  it("discovers and selects AI agents", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: SAMPLE_AGENTS, total: 2 });

    const multiselectMock = vi.fn().mockResolvedValue(EXPECTED_AGENT_ENTRIES);
    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-agents"),
      multiselect: multiselectMock,
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toEqual(EXPECTED_AGENT_ENTRIES);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Selected 2 agents for A2A"),
      "AI Fabric — Agents",
    );
  });

  it("filters out agents without endpoints", async () => {
    const agentsWithMissingEndpoint: Agent[] = [
      ...SAMPLE_AGENTS,
      {
        id: "agent-no-ep",
        name: "no-endpoint-agent",
        status: "RUNNING",
        endpoint: undefined,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      },
    ];
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: agentsWithMissingEndpoint, total: 3 });

    const multiselectMock = vi.fn().mockResolvedValue(EXPECTED_AGENT_ENTRIES);
    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-filter"),
      multiselect: multiselectMock,
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    // Only 2 agents shown in multiselect (the one without endpoint is filtered)
    const multiselectCall = multiselectMock.mock.calls[0][0] as { options: unknown[] };
    expect(multiselectCall.options).toHaveLength(2);
  });

  it("handles agent discovery API error gracefully", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockRejectedValue(new Error("IAM auth failed"));

    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-agent-fail"),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    // Should continue without agents, not crash
    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-agent-fail");
    expect(result.config.aiFabric?.agents).toBeUndefined();
  });

  it("user selects no agents — agents not written to config", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: SAMPLE_AGENTS, total: 2 });

    const multiselectMock = vi.fn().mockResolvedValue([]);
    const prompter = createMockPrompter({
      confirm: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue("proj-no-select"),
      multiselect: multiselectMock,
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      auth: { keyId: "test-key", secret: "test-secret" },
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.agents).toBeUndefined();
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
    mockListAgents.mockRejectedValue(new Error("Connection refused"));

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
    mockListAgents.mockResolvedValue({ items: [], total: 0 });

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-empty",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-empty");
  });

  it("auto-discovers running agents with endpoints", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: SAMPLE_AGENTS, total: 2 });

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-agents-ni",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toEqual(EXPECTED_AGENT_ENTRIES);
  });

  it("filters out agents without endpoints in non-interactive mode", async () => {
    const mixedAgents: Agent[] = [
      SAMPLE_AGENTS[0],
      {
        id: "agent-no-ep",
        name: "no-endpoint",
        status: "RUNNING",
        endpoint: undefined,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      },
    ];
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: mixedAgents, total: 2 });

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-filter-ni",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toHaveLength(1);
    expect(result.config.aiFabric?.agents?.[0].id).toBe("agent-1");
  });

  it("continues when agent discovery fails", async () => {
    mockListMcpServers.mockResolvedValue({ items: SAMPLE_SERVERS, total: 2 });
    mockListAgents.mockRejectedValue(new Error("Connection refused"));

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-agent-fail-ni",
      workspaceDir: tmpDir,
    });

    // MCP still works, agents fail — configured=true because MCP succeeded
    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toBeUndefined();
  });

  it("configured=true when only agents found (no MCP servers)", async () => {
    mockListMcpServers.mockResolvedValue({ items: [], total: 0 });
    mockListAgents.mockResolvedValue({ items: SAMPLE_AGENTS, total: 2 });

    const result = await setupAiFabricNonInteractive({
      config: BASE_CONFIG,
      auth: { keyId: "test-key", secret: "test-secret" },
      projectId: "proj-agents-only",
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.mcpConfigPath).toBeUndefined();
    expect(result.config.aiFabric?.agents).toHaveLength(2);
  });
});

describe("setupAiFabric — manual entry (no IAM auth)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-ai-fabric-manual-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("full manual flow: MCP servers + agents without IAM", async () => {
    // Simulates the exact wizard interaction from the verification plan:
    // - User confirms AI Fabric → Yes
    // - Enters project ID "test-project-123"
    // - No IAM → manual entry path
    // - Confirms manual MCP → Yes
    // - Enters MCP server "web-search" at given URL
    // - Declines adding more MCP servers
    // - Confirms manual agents → Yes
    // - Enters agent "code-assistant" at given URL
    // - Declines adding more agents
    const confirmCalls: boolean[] = [
      true, // "Connect Cloud.ru AI Fabric MCP servers?" → Yes
      true, // "Enter MCP server URLs manually?" → Yes
      false, // "Add another MCP server?" → No
      true, // "Enter AI Agent endpoints manually?" → Yes
      false, // "Add another agent?" → No
    ];
    let confirmIdx = 0;

    const textCalls: string[] = [
      "test-project-123", // Project ID
      "web-search", // MCP server name
      "https://ai-agents.api.cloud.ru/mcp/mcp-test-1", // MCP server URL
      "code-assistant", // Agent name
      "https://ai-agents.api.cloud.ru/a2a/agent-test-1", // Agent URL
    ];
    let textIdx = 0;

    const noteMock = vi.fn();
    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockImplementation(() => Promise.resolve(textCalls[textIdx++])),
      note: noteMock,
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      // auth omitted — triggers manual entry
      workspaceDir: tmpDir,
    });

    // --- Verify result ---
    expect(result.configured).toBe(true);
    expect(result.config.aiFabric).toBeDefined();

    const aiFabric = result.config.aiFabric!;
    expect(aiFabric.enabled).toBe(true);
    expect(aiFabric.projectId).toBe("test-project-123");

    // keyId must be absent (IAM was skipped)
    expect(aiFabric.keyId).toBeUndefined();

    // Agent with manual- prefix
    expect(aiFabric.agents).toHaveLength(1);
    expect(aiFabric.agents![0]).toEqual({
      id: "manual-code-assistant",
      name: "code-assistant",
      endpoint: "https://ai-agents.api.cloud.ru/a2a/agent-test-1",
    });

    // mcpConfigPath points to the file
    expect(aiFabric.mcpConfigPath).toBe(path.join(tmpDir, CLOUDRU_MCP_CONFIG_FILENAME));

    // --- Verify MCP config file ---
    const mcpConfigPath = path.join(tmpDir, CLOUDRU_MCP_CONFIG_FILENAME);
    const mcpContent = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
    expect(mcpContent).toEqual({
      mcpServers: {
        "web-search": {
          url: "https://ai-agents.api.cloud.ru/mcp/mcp-test-1",
          transport: "sse",
        },
      },
    });

    // URL must be exactly as entered (not constructed from base + id)
    expect(mcpContent.mcpServers["web-search"].url).toBe(
      "https://ai-agents.api.cloud.ru/mcp/mcp-test-1",
    );

    // --- Verify CLI backend args ---
    const cliBackend = result.config.agents?.defaults?.cliBackends?.["claude-cli"] as Record<
      string,
      unknown
    >;
    const args = cliBackend.args as string[];
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    expect(args).toContain(mcpConfigPath);

    // --- Verify note messages ---
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 MCP server"),
      "AI Fabric — MCP",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 agent"),
      "AI Fabric — Agents",
    );
  });

  it("manual MCP only — user declines manual agents", async () => {
    const confirmCalls: boolean[] = [
      true, // Connect AI Fabric → Yes
      true, // Enter MCP URLs manually → Yes
      false, // Add another MCP → No
      false, // Enter agents manually → No
    ];
    let confirmIdx = 0;

    const textCalls: string[] = [
      "proj-mcp-only",
      "search-server",
      "https://example.com/mcp/search",
    ];
    let textIdx = 0;

    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockImplementation(() => Promise.resolve(textCalls[textIdx++])),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toBeUndefined();
    expect(result.config.aiFabric?.mcpConfigPath).toBeDefined();
    expect(result.config.aiFabric?.keyId).toBeUndefined();
  });

  it("manual agents only — user declines manual MCP", async () => {
    const confirmCalls: boolean[] = [
      true, // Connect AI Fabric → Yes
      false, // Enter MCP URLs manually → No
      true, // Enter agents manually → Yes
      false, // Add another agent → No
    ];
    let confirmIdx = 0;

    const textCalls: string[] = [
      "proj-agents-only",
      "my-agent",
      "https://example.com/a2a/my-agent",
    ];
    let textIdx = 0;

    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockImplementation(() => Promise.resolve(textCalls[textIdx++])),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);
    expect(result.config.aiFabric?.agents).toHaveLength(1);
    expect(result.config.aiFabric?.agents![0].id).toBe("manual-my-agent");
    expect(result.config.aiFabric?.mcpConfigPath).toBeUndefined();
    // No --mcp-config args when no MCP servers
    const cliBackend = result.config.agents?.defaults?.cliBackends?.["claude-cli"] as Record<
      string,
      unknown
    >;
    expect(cliBackend.args).toBeUndefined();
  });

  it("user declines both manual MCP and agents → configured=false", async () => {
    const confirmCalls: boolean[] = [
      true, // Connect AI Fabric → Yes
      false, // Enter MCP URLs manually → No
      false, // Enter agents manually → No
    ];
    let confirmIdx = 0;

    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockResolvedValue("proj-nothing"),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(false);
    expect(result.config.aiFabric?.projectId).toBe("proj-nothing");
    expect(result.config.aiFabric?.keyId).toBeUndefined();
  });

  it("multiple manual MCP servers and agents", async () => {
    const confirmCalls: boolean[] = [
      true, // Connect AI Fabric → Yes
      true, // Enter MCP URLs manually → Yes
      true, // Add another MCP → Yes
      false, // Add another MCP → No
      true, // Enter agents manually → Yes
      true, // Add another agent → Yes
      false, // Add another agent → No
    ];
    let confirmIdx = 0;

    const textCalls: string[] = [
      "proj-multi",
      "web-search",
      "https://example.com/mcp/1",
      "code-runner",
      "https://example.com/mcp/2",
      "assistant-1",
      "https://example.com/a2a/1",
      "assistant-2",
      "https://example.com/a2a/2",
    ];
    let textIdx = 0;

    const noteMock = vi.fn();
    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockImplementation(() => Promise.resolve(textCalls[textIdx++])),
      note: noteMock,
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      workspaceDir: tmpDir,
    });

    expect(result.configured).toBe(true);

    // 2 MCP servers
    const mcpConfigPath = path.join(tmpDir, CLOUDRU_MCP_CONFIG_FILENAME);
    const mcpContent = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
    expect(Object.keys(mcpContent.mcpServers)).toHaveLength(2);
    expect(mcpContent.mcpServers["web-search"].url).toBe("https://example.com/mcp/1");
    expect(mcpContent.mcpServers["code-runner"].url).toBe("https://example.com/mcp/2");

    // 2 agents
    expect(result.config.aiFabric?.agents).toHaveLength(2);
    expect(result.config.aiFabric?.agents![0].id).toBe("manual-assistant-1");
    expect(result.config.aiFabric?.agents![1].id).toBe("manual-assistant-2");

    // Note messages
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Configured 2 MCP servers"),
      "AI Fabric — MCP",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Configured 2 agents"),
      "AI Fabric — Agents",
    );
  });

  it("agent id slug handles special characters", async () => {
    const confirmCalls: boolean[] = [
      true, // Connect AI Fabric → Yes
      false, // Enter MCP URLs manually → No
      true, // Enter agents manually → Yes
      false, // Add another agent → No
    ];
    let confirmIdx = 0;

    const textCalls: string[] = [
      "proj-slug",
      "My Cool Agent!!! (v2)",
      "https://example.com/a2a/cool",
    ];
    let textIdx = 0;

    const prompter = createMockPrompter({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(confirmCalls[confirmIdx++])),
      text: vi.fn().mockImplementation(() => Promise.resolve(textCalls[textIdx++])),
    });

    const result = await setupAiFabric({
      config: BASE_CONFIG,
      prompter,
      workspaceDir: tmpDir,
    });

    expect(result.config.aiFabric?.agents![0].id).toBe("manual-my-cool-agent-v2");
    expect(result.config.aiFabric?.agents![0].name).toBe("My Cool Agent!!! (v2)");
  });
});
