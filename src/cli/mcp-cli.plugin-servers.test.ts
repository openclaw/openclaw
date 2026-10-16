// MCP CLI tests for MCP servers contributed by enabled plugins. These live in
// their own file because the plugin metadata snapshot is process-stable, so a
// shared module cache would hide the temp-home plugin fixture (issue #165951).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli plugin-contributed servers", () => {
  beforeEach(() => {
    resetMcpCliTestState();
    // The plugin metadata snapshot is process-stable by design; clear it so this
    // test observes the temp-home plugin fixture instead of an earlier snapshot.
    resetPluginCache();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
    resetPluginCache();
  });

  it("lists and authorizes MCP servers contributed by enabled plugins", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      const pluginRoot = path.join(home, ".openclaw", "extensions", "gitlab");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "gitlab" }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              gitlab: {
                type: "http",
                url: "https://gitlab.example.com/api/v4/mcp",
                auth: "oauth",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".openclaw", "openclaw.json"),
        `${JSON.stringify({ plugins: { entries: { gitlab: { enabled: true } } } })}\n`,
        "utf8",
      );

      // `mcp list` must surface the plugin-declared server; otherwise the CLI
      // cannot reach it for OAuth authorization.
      mockLog.mockClear();
      await runMcpCommand(["mcp", "list", "--json"]);
      const listed = JSON.parse(lastLogLine());
      expect(Object.keys(listed)).toContain("gitlab");
      expect(listed.gitlab).toMatchObject({ auth: "oauth" });

      // `mcp login` resolves the same effective view and completes the flow.
      mockLog.mockClear();
      await runMcpCommand(["mcp", "login", "gitlab", "--code", "test-code"]);
      expect(lastLogLine()).toBe('MCP OAuth credentials saved for "gitlab".');
    });
  });
});
