import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("MCP doctor stdio commands that resolve to directories", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("reports directories and continues past them on PATH", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const serverDir = path.join(workspaceDir, "docs-mcp-repo");
      const shadowDir = path.join(workspaceDir, "shadow");
      const binDir = path.join(workspaceDir, "bin");
      await fs.mkdir(serverDir, { recursive: true });
      await fs.mkdir(path.join(shadowDir, "docs-mcp"), { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(path.join(binDir, "docs-mcp"), "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(path.join(binDir, "docs-mcp"), 0o755);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const servers = {
        "explicit-dir": { command: serverDir },
        "path-dir-only": { command: "docs-mcp", env: { PATH: shadowDir } },
        "path-dir-then-file": {
          command: "docs-mcp",
          env: { PATH: [shadowDir, binDir].join(path.delimiter) },
        },
      };
      for (const [name, server] of Object.entries(servers)) {
        await runMcpCommand(["mcp", "set", name, JSON.stringify(server)]);
      }
      mockLog.mockClear();

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow("__exit__:1");

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: false,
        servers: [
          {
            name: "explicit-dir",
            ok: false,
            issues: [
              {
                level: "error",
                message: `stdio command not found or not executable: ${serverDir}`,
              },
            ],
          },
          {
            name: "path-dir-only",
            ok: false,
            issues: [
              { level: "error", message: "stdio command not found or not executable: docs-mcp" },
            ],
          },
          { name: "path-dir-then-file", ok: true, issues: [] },
        ],
      });
    });
  });
});
