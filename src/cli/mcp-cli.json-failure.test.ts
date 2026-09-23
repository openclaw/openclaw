import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockError,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli JSON failures", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it.each(["show", "probe", "doctor"])(
    "emits one JSON failure for an unknown server in %s",
    async (command) => {
      await withTempHome("openclaw-cli-mcp-json-", async () => {
        await expect(runMcpCommand(["mcp", command, "missing", "--json"])).rejects.toThrow(
          "__exit__:1",
        );

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect(mockError).not.toHaveBeenCalled();
        expect(JSON.parse(lastLogLine())).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining('No MCP server named "missing"'),
          },
        });
      });
    },
  );

  it.each(["list", "show", "status", "probe", "doctor"])(
    "emits one JSON failure for invalid config in %s",
    async (command) => {
      await withTempHome("openclaw-cli-mcp-invalid-json-", async (home) => {
        await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), "{ invalid");
        await expect(runMcpCommand(["mcp", command, "--json"])).rejects.toThrow("__exit__:1");

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect(JSON.parse(lastLogLine())).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Config file is invalid; fix it before using MCP config commands.",
          },
        });
      });
    },
  );

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
