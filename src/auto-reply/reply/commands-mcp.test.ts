// Tests MCP command configuration, listing, and enablement behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const mcpServers = vi.hoisted(() => new Map<string, Record<string, unknown>>());

const mcpRuntimeMocks = vi.hoisted(() => ({
  peekSessionMcpRuntime: vi.fn<
    (params: {
      sessionId?: string | null;
      sessionKey?: string | null;
    }) => Pick<SessionMcpRuntime, "configFingerprint" | "peekCatalog" | "workspaceDir"> | undefined
  >(() => undefined),
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:0",
    serverNames: [] as string[],
  })),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => mcpRuntimeMocks);

vi.mock("../../config/mcp-config.js", () => ({
  listConfiguredMcpServers: vi.fn(async () => ({
    ok: true,
    path: "/tmp/openclaw.json",
    config: {},
    mcpServers: Object.fromEntries(mcpServers),
  })),
  setConfiguredMcpServer: vi.fn(async ({ name, server }) => {
    mcpServers.set(name, { ...(server as Record<string, unknown>) });
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
    };
  }),
  unsetConfiguredMcpServer: vi.fn(async ({ name }) => {
    const removed = mcpServers.delete(name);
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
      removed,
    };
  }),
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-mcp-");

function expectMcpResult<T>(result: T | null): T {
  if (result === null) {
    throw new Error("expected MCP command result");
  }
  return result;
}

function buildCfg(): OpenClawConfig {
  return {
    commands: {
      text: true,
      mcp: true,
    },
  };
}

function makeCatalog(
  overrides: Partial<McpToolCatalog> & Pick<McpToolCatalog, "servers"> = { servers: {} },
): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 0,
    tools: [],
    ...overrides,
  };
}

describe("handleCommands /mcp", () => {
  afterEach(async () => {
    mcpServers.clear();
    await workspaceHarness.cleanupWorkspaces();
    mcpRuntimeMocks.peekSessionMcpRuntime.mockReset().mockReturnValue(undefined);
    mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReset().mockReturnValue({
      fingerprint: "mcp:0",
      serverNames: [],
    });
  });

  it("shows connected live state for a server with a warm catalog", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const catalog = makeCatalog({
        servers: { context7: { serverName: "context7", launchSummary: "uvx", toolCount: 3 } },
      });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => catalog,
      });
      mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
        fingerprint: "mcp:1",
        serverNames: ["context7"],
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain("🩺 Live state (session):");
      expect(result.reply?.text).toContain("context7: ✅ connected (3 tools)");
    });
  });

  it('uses singular "tool" for a server with exactly one tool', async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const catalog = makeCatalog({
        servers: { context7: { serverName: "context7", launchSummary: "uvx", toolCount: 1 } },
      });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => catalog,
      });
      mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
        fingerprint: "mcp:1",
        serverNames: ["context7"],
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain("context7: ✅ connected (1 tool)");
    });
  });

  it("shows a diagnostic live-state line for a server that failed to connect", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const catalog = makeCatalog({
        servers: {},
        diagnostics: [
          {
            serverName: "context7",
            safeServerName: "context7",
            launchSummary: "uvx",
            message: "connect ECONNREFUSED",
          },
        ],
      });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => catalog,
      });
      mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
        fingerprint: "mcp:1",
        serverNames: ["context7"],
      });

      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain("context7: ⚠️ connect ECONNREFUSED");
    });
  });

  it("shows a disabled live-state line instead of not-yet-discovered for enabled:false servers", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"], enabled: false });
      // The bundle-MCP runtime excludes enabled:false servers entirely, so the
      // warm catalog it built never mentions "context7" — not in servers, not
      // in diagnostics. That absence must read as "disabled", not "pending".
      const catalog = makeCatalog({ servers: {} });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => catalog,
      });
      mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
        fingerprint: "mcp:1",
        serverNames: [],
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain(
        "context7: 🚫 disabled (enabled: false, excluded from runtime)",
      );
      expect(result.reply?.text).not.toContain("not yet discovered");
    });
  });

  it("marks live state stale when the session catalog predates the current config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const catalog = makeCatalog({
        servers: { context7: { serverName: "context7", launchSummary: "uvx", toolCount: 3 } },
      });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:old",
        workspaceDir,
        peekCatalog: () => catalog,
      });
      mcpRuntimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
        fingerprint: "mcp:new",
        serverNames: ["context7"],
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain(
        "context7: ♻️ config changed since last connect (stale)",
      );
    });
  });

  it("shows a not-yet-discovered note when the session runtime has no catalog yet", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => null,
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain("🩺 Live state (session):");
      expect(result.reply?.text).toContain(
        "context7: ⏳ not yet discovered — connects on next agent MCP tool use.",
      );
    });
  });

  it("shows disabled (not not-yet-discovered) for enabled:false servers even before the session catalog is built", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"], enabled: false });
      // Session runtime exists but hasn't built a catalog yet (cold path) —
      // the disabled check must still win over the generic "connects on next
      // agent MCP tool use" fallback, since a disabled server never connects.
      mcpRuntimeMocks.peekSessionMcpRuntime.mockReturnValue({
        configFingerprint: "mcp:1",
        workspaceDir,
        peekCatalog: () => null,
      });

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(result.reply?.text).toContain(
        "context7: 🚫 disabled (enabled: false, excluded from runtime)",
      );
      expect(result.reply?.text).not.toContain("not yet discovered");
    });
  });

  it("renders byte-identical output to the pre-live-state baseline when no session runtime exists yet", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const server = { command: "uvx", args: ["context7-mcp"] };
      mcpServers.set("context7", server);

      const showParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const result = expectMcpResult(await handleMcpCommand(showParams, true));
      // Exact match against what /mcp show rendered before this PR (a single
      // JSON block, no live-state block appended) — not just a substring
      // check — so a future regression that always appends a live-state
      // section (even an empty one) would be caught.
      const expectedLegacyText = `🔌 MCP servers (/tmp/openclaw.json)\n\`\`\`json\n${JSON.stringify(
        { context7: server },
        null,
        2,
      )}\n\`\`\``;
      expect(result.reply?.text).toBe(expectedLegacyText);
    });
  });

  it("writes MCP config and shows it back", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const setParams = buildCommandTestParams(
        '/mcp set context7={"command":"uvx","args":["context7-mcp"]}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      setParams.command.senderIsOwner = true;

      const setResult = expectMcpResult(await handleMcpCommand(setParams, true));
      expect(setResult.reply?.text).toContain('MCP server "context7" saved');

      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const showResult = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(showResult.reply?.text).toContain('"command": "uvx"');
      expect(showResult.reply?.text).toContain('"args": [');
    });
  });

  it("blocks authorized non-owner senders from writing MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("existing", { command: "uvx", args: ["existing-mcp"] });
      const setParams = buildCommandTestParams(
        '/mcp set evil={"command":"/bin/sh","args":["-c","id > /tmp/pwned"]}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      setParams.command.senderIsOwner = false;

      const setResult = expectMcpResult(await handleMcpCommand(setParams, true));
      expect(setResult).toEqual({ shouldContinue: false });
      expect(mcpServers.has("evil")).toBe(false);

      const unsetParams = buildCommandTestParams("/mcp unset existing", buildCfg(), undefined, {
        workspaceDir,
      });
      unsetParams.command.senderIsOwner = false;
      const unsetResult = expectMcpResult(await handleMcpCommand(unsetParams, true));
      expect(unsetResult).toEqual({ shouldContinue: false });
      expect(mcpServers.has("existing")).toBe(true);
    });
  });

  it("blocks authorized non-owner senders from reading MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = false;

      const showResult = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(showResult).toEqual({ shouldContinue: false });
      const replyText = showResult.reply?.text ?? "";
      expect(replyText).not.toContain('MCP server "context7"');
      expect(replyText).not.toContain('"command": "uvx"');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildCommandTestParams(
        '/mcp set context7={"command":"uvx","args":["context7-mcp"]}',
        buildCfg(),
        {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: ["operator.write"],
        },
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = expectMcpResult(await handleMcpCommand(params, true));
      expect(result.reply?.text).toContain("requires operator.admin");
    });
  });

  it("accepts non-stdio MCP config at the config layer", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildCommandTestParams(
        '/mcp set remote={"url":"https://example.com/mcp"}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = expectMcpResult(await handleMcpCommand(params, true));
      expect(result.reply?.text).toContain('MCP server "remote" saved');
    });
  });
});
