import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  // Command-level suites own the individual validation branches. Keep one
  // built-process proof per agent command family and output finalizer here.
  it.each([
    {
      name: "add without an interactive terminal in human mode",
      args: ["agents", "add", "work"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
      human: true,
    },
    {
      name: "add without an interactive terminal in JSON wizard mode",
      args: ["agents", "add", "work", "--json"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
    },
    {
      name: "add without a workspace through dual-TTY finalization",
      args: ["agents", "add", "work", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
      tty: true,
    },
    {
      name: "bind without bindings",
      args: ["agents", "bind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "unbind with incompatible options in human mode",
      args: ["agents", "unbind", "--all", "--bind", "telegram"],
      message: "Use either --all or --bind, not both.",
      human: true,
    },
    {
      name: "set-identity with an unknown agent in JSON mode",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
    },
    {
      name: "set-identity with an unknown agent through dual-TTY finalization",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
      tty: true,
    },
  ])("renders agent management $name through the canonical failure owner", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const args = testCase.args.map((argument) =>
          argument === "$WORKSPACE" ? workspace : argument,
        );
        const result = runBuiltCli(
          tempHome,
          args,
          {
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: configPath,
            ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
          },
          { execArgv: "tty" in testCase ? [`--import=${preload}`] : [] },
        );

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(result.stdout, result.stderr).not.toContain("\u001B");
          expect(result.stdout, result.stderr).not.toContain("\u0007");
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-agent-management-json-failure-e2e-" },
    );
  });

  it("leaves existing config and IDENTITY.md untouched when set-identity rejects an agent", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const identityPath = path.join(workspace, "IDENTITY.md");
        const originalConfig = `${JSON.stringify({
          agents: { entries: { main: { workspace, identity: { name: "Original" } } } },
        })}\n`;
        const originalIdentity = "- Name: Original workspace identity\n";
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(configPath, originalConfig, "utf8");
        await fs.writeFile(identityPath, originalIdentity, "utf8");

        const result = runBuiltCli(
          tempHome,
          ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
          {
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: configPath,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
          },
        });
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalConfig);
        await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
      },
      { prefix: "openclaw-agent-identity-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "bindings list success",
      args: ["agents", "bindings", "--json"],
      payload: [],
    },
    {
      name: "bind success",
      args: ["agents", "bind", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: ["telegram accountId=work"],
        updated: [],
        skipped: [],
        conflicts: [],
      },
      writesConfig: true,
    },
    {
      name: "unbind-all success",
      args: ["agents", "unbind", "--all", "--json"],
      payload: { agentId: "main", removed: [], missing: [], conflicts: [] },
    },
    {
      name: "bind ownership conflict",
      args: ["agents", "bind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: [],
        updated: [],
        skipped: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
    {
      name: "unbind ownership conflict",
      args: ["agents", "unbind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        removed: [],
        missing: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
  ])("preserves agent binding $name as its existing domain payload", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const existingConfig = `${JSON.stringify({
          agents: {
            ownership: "explicit",
            list: [
              { id: "main", workspace: path.join(tempHome, "main") },
              { id: "ops", workspace: path.join(tempHome, "ops") },
            ],
          },
          bindings: [
            { type: "route", agentId: "ops", match: { channel: "telegram", accountId: "work" } },
          ],
        })}\n`;
        if ("conflict" in testCase) {
          await fs.writeFile(configPath, existingConfig, "utf8");
        }

        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
        });

        expect(result.status, result.stderr).toBe("conflict" in testCase ? 1 : 0);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(JSON.parse(result.stdout)).toEqual(testCase.payload);
        if ("writesConfig" in testCase) {
          await expect(fs.access(configPath)).resolves.toBeUndefined();
        } else if ("conflict" in testCase) {
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
        } else {
          await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
      { prefix: "openclaw-agent-bindings-domain-payload-e2e-" },
    );
  });
});
