import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-mcp-"));
  tempDirs.push(dir);
  return dir;
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
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes MCP config and shows it back", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const setParams = buildCommandTestParams(
        '/mcp set context7={"command":"uvx","args":["context7-mcp"]}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      setParams.command.senderIsOwner = true;

      const setResult = await handleCommands(setParams);
      expect(setResult.reply?.text).toContain('MCP server "context7" saved');

      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const showResult = await handleCommands(showParams);
      expect(showResult.reply?.text).toContain('"command": "uvx"');
      expect(showResult.reply?.text).toContain('"args": [');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
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

      const result = await handleCommands(params);
      expect(result.reply?.text).toContain("requires operator.admin");
    });
  });

  it("accepts non-stdio MCP config at the config layer", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const params = buildCommandTestParams(
        '/mcp set remote={"url":"https://example.com/mcp"}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = await handleCommands(params);
      expect(result.reply?.text).toContain('MCP server "remote" saved');
    });
  });
});
