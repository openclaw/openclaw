import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { createWorkspace, lastLogLine, mockLog, runMcpCommand } from "./mcp-cli.test-harness.js";

export function registerMcpCliDoctorPathTests(
  withMcpHome: (run: (home: string, workspaceDir: string) => Promise<void>) => Promise<void>,
): void {
  it.runIf(process.platform !== "win32")(
    "does not treat Path as PATH when checking MCP stdio commands",
    async () => {
      await withMcpHome(async (_home, workspaceDir) => {
        const binDir = path.join(workspaceDir, "bin");
        const commandPath = path.join(binDir, "mis-cased-path-mcp");
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(commandPath, 0o755);

        await runMcpCommand([
          "mcp",
          "set",
          "docs",
          JSON.stringify({ command: "mis-cased-path-mcp", env: { Path: binDir } }),
        ]);
        mockLog.mockClear();

        await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toMatchObject({ code: 1 });

        expect(JSON.parse(lastLogLine())).toMatchObject({
          ok: false,
          servers: [
            {
              name: "docs",
              ok: false,
              issues: [
                {
                  level: "error",
                  message: "stdio command not found or not executable: mis-cased-path-mcp",
                },
              ],
            },
          ],
        });
      });
    },
  );

  it("resolves relative configured PATH entries from the MCP stdio cwd", async () => {
    await withMcpHome(async (_home, workspaceDir) => {
      const appDir = path.join(workspaceDir, "app");
      const binDir = path.join(appDir, "node_modules", ".bin");
      const commandPath = path.join(binDir, "docs-mcp");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(commandPath, 0o755);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: "docs-mcp",
          cwd: appDir,
          env: { PATH: "node_modules/.bin" },
        }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [{ name: "docs", ok: true, issues: [] }],
      });
    });
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

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toMatchObject({ code: 1 });

      const issue = (message: string) => [{ level: "error", message }];
      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: false,
        servers: [
          {
            name: "explicit-dir",
            ok: false,
            issues: issue(`stdio command not found or not executable: ${serverDir}`),
          },
          {
            name: "path-dir-only",
            ok: false,
            issues: issue("stdio command not found or not executable: docs-mcp"),
          },
          { name: "path-dir-then-file", ok: true, issues: [] },
        ],
      });
    });
  });
}
