import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-mcp-");

function expectMcpResult<T>(result: T | null): T {
  expect(result).toBeTruthy();
  if (!result) {
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

describe("handleCommands /mcp", () => {
  afterEach(async () => {
    await workspaceHarness.cleanupWorkspaces();
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
