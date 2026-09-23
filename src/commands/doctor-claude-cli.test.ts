// Doctor Claude CLI tests cover CLI discovery, version checks, and repair guidance.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { withEnvAsync } from "../test-utils/env.js";
import { noteClaudeCliHealth } from "./doctor-claude-cli.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const resolveCliBackendConfigMock = vi.hoisted(() => vi.fn());
const resolveModelAgentRuntimeMetadataMock = vi.hoisted(() =>
  vi
    .fn<typeof import("../agents/agent-runtime-metadata.js").resolveModelAgentRuntimeMetadata>()
    .mockReturnValue({ id: "openclaw", source: "implicit" }),
);

vi.mock("../agents/cli-backends.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/cli-backends.js")>()),
  resolveCliBackendConfig: resolveCliBackendConfigMock,
}));

vi.mock("../agents/agent-runtime-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-runtime-metadata.js")>()),
  resolveModelAgentRuntimeMetadata: resolveModelAgentRuntimeMetadataMock,
}));

async function withTempHome<T>(
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-claude-cli-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    return await run({ homeDir, workspaceDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function noteBody(noteFn: ReturnType<typeof vi.fn>): string {
  const value = expectDefined<unknown[]>(noteFn.mock.calls[0], "note call").at(0);
  if (typeof value !== "string") {
    throw new Error("Expected note body");
  }
  return value;
}

function noteTitle(noteFn: ReturnType<typeof vi.fn>): string {
  const value = expectDefined<unknown[]>(noteFn.mock.calls[0], "note call").at(1);
  if (typeof value !== "string") {
    throw new Error("Expected note title");
  }
  return value;
}

describe("noteClaudeCliHealth", () => {
  afterEach(() => {
    resolveCliBackendConfigMock.mockReset();
    resolveModelAgentRuntimeMetadataMock
      .mockReset()
      .mockReturnValue({ id: "openclaw", source: "implicit" });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    clearHealthChecksForTest();
  });

  it("probes the executable resolved by the owning backend", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveCliBackendConfigMock.mockReturnValue({
        id: "claude-cli",
        pluginId: "custom-anthropic",
        config: { command: "/opt/custom/bin/claude" },
      });
      const resolveCommandPath = vi.fn(() => undefined);

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn: vi.fn(),
          resolveCommandPath,
        },
      );

      expect(resolveCommandPath).toHaveBeenCalledWith("/opt/custom/bin/claude", expect.any(Object));
    });
  });

  it("stays quiet when Claude CLI is not configured or detected", () => {
    const noteFn = vi.fn();
    noteClaudeCliHealth(
      {},
      {
        noteFn,
      },
    );
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("stays quiet for a healthy claude-cli setup", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
      fs.mkdirSync(projectDir, { recursive: true });

      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          isAuthenticated: () => true,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("probes auth with the same cleared environment as Claude execution", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveCliBackendConfigMock.mockReturnValue({
        id: "claude-cli",
        pluginId: "anthropic",
        config: {
          command: "claude",
          clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
      });
      const isAuthenticated = vi.fn(() => true);

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: { default: true } },
          },
        },
        {
          env: {
            ANTHROPIC_API_KEY: "ambient-api-key",
            CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token",
            CLAUDE_CONFIG_DIR: "/tmp/claude-config",
            PATH: "/usr/bin",
          },
          homeDir,
          workspaceDir,
          isAuthenticated,
          noteFn: vi.fn(),
          resolveCommandPath: () => "/usr/bin/claude",
        },
      );

      expect(isAuthenticated).toHaveBeenCalledWith("/usr/bin/claude", {
        CLAUDE_CONFIG_DIR: "/tmp/claude-config",
        PATH: "/usr/bin",
      });
    });
  });

  it("stays quiet for a healthy non-default Claude CLI runtime agent", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveModelAgentRuntimeMetadataMock.mockImplementation(({ agentId }) => ({
        id: agentId === "xiaoao" ? "claude-cli" : "openclaw",
        source: agentId === "xiaoao" ? "model" : "implicit",
      }));
      const root = path.dirname(workspaceDir);
      const defaultWorkspace = path.join(root, "workspace-coder");
      const claudeWorkspace = path.join(root, "workspace-xiaoao");
      fs.mkdirSync(defaultWorkspace, { recursive: true });
      fs.mkdirSync(claudeWorkspace, { recursive: true });
      const projectDir = resolveClaudeCliProjectDirForWorkspace({
        workspaceDir: claudeWorkspace,
        homeDir,
      });
      fs.mkdirSync(projectDir, { recursive: true });

      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
            list: [
              {
                id: "coder",
                default: true,
                workspace: defaultWorkspace,
              },
              {
                id: "xiaoao",
                workspace: claudeWorkspace,
                model: "anthropic/claude-opus-4-7",
                models: {
                  "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
                },
              },
            ],
          },
        },
        {
          homeDir,
          noteFn,
          isAuthenticated: () => true,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteFn).not.toHaveBeenCalled();
    });
  });

  it("reports when Claude CLI owns no active login", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          isAuthenticated: () => false,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain("Claude auth: not logged in.");
      expect(body).toContain("claude auth login");
      expect(body).not.toContain("openclaw models auth login");
    });
  });

  it("warns when the Claude binary is missing", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
            entries: { main: { default: true } },
          },
        },
        {
          homeDir,
          workspaceDir,
          noteFn,
          resolveCommandPath: () => undefined,
        },
      );

      const body = noteBody(noteFn);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).not.toContain("claude auth login");
    });
  });

  it("lists Claude CLI agents only when a problem is reported", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      resolveModelAgentRuntimeMetadataMock.mockReturnValue({
        id: "claude-cli",
        source: "model",
      });
      const root = path.dirname(workspaceDir);
      const alphaWorkspace = path.join(root, "workspace-alpha");
      const zetaWorkspace = path.join(root, "workspace-zeta");
      fs.writeFileSync(alphaWorkspace, "not a directory");
      fs.mkdirSync(zetaWorkspace, { recursive: true });
      const runtimeModel = "anthropic/claude-opus-4-7";
      const noteFn = vi.fn();

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: { primary: runtimeModel } },
            list: [
              {
                id: "zeta",
                default: true,
                workspace: zetaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
              {
                id: "alpha",
                workspace: alphaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
            ],
          },
        },
        {
          homeDir,
          noteFn,
          isAuthenticated: () => true,
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
        },
      );

      expect(noteTitle(noteFn)).toBe("Claude CLI");
      const body = noteBody(noteFn);
      expect(body).toContain(
        `Agent alpha workspace: ${alphaWorkspace} exists but is not a directory.`,
      );
      expect(body).toContain("Agents using Claude CLI: alpha, zeta.");
      expect(body).not.toContain(`Agent zeta workspace: ${zetaWorkspace}`);
    });
  });

  // Registered CLI entry; routed by test/vitest/vitest.commands.config.ts.
  it.each(["cyclic project", "blocked workspace", "readable", "missing"])(
    "doctor --lint --only core/doctor/claude-cli reports a %s directory at final output",
    async (scenario) => {
      clearHealthChecksForTest();
      await withTempHome(async ({ homeDir, workspaceDir }) => {
        const configPath = path.join(homeDir, "openclaw.json");
        let configuredWorkspace = workspaceDir;
        if (scenario === "blocked workspace") {
          const parent = path.join(workspaceDir, "parent");
          fs.writeFileSync(parent, "not a directory");
          configuredWorkspace = path.join(parent, "child");
        } else if (scenario === "missing") {
          configuredWorkspace = path.join(workspaceDir, "missing");
        }
        const projectDir = resolveClaudeCliProjectDirForWorkspace({
          workspaceDir: configuredWorkspace,
          homeDir,
        });
        fs.mkdirSync(path.dirname(projectDir), { recursive: true });
        if (scenario === "cyclic project") {
          fs.symlinkSync(projectDir, projectDir, process.platform === "win32" ? "junction" : "dir");
        } else if (scenario === "readable") {
          fs.mkdirSync(projectDir);
        }
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            agents: {
              ownership: "explicit",
              defaults: {
                model: "anthropic/fixture",
                models: { "anthropic/fixture": { agentRuntime: { id: "claude-cli" } } },
                workspace: configuredWorkspace,
              },
              entries: { main: {} },
            },
          }),
        );
        const actualRuntime = await vi.importActual<
          typeof import("../agents/agent-runtime-metadata.js")
        >("../agents/agent-runtime-metadata.js");
        resolveModelAgentRuntimeMetadataMock.mockImplementation(
          actualRuntime.resolveModelAgentRuntimeMetadata,
        );
        resolveCliBackendConfigMock.mockReturnValue({
          id: "claude-cli",
          config: { command: process.execPath },
        });
        const spawnSync = childProcess.spawnSync;
        vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
          if (
            args[0] === process.execPath &&
            args[1]?.[0] === "auth" &&
            args[1]?.[1] === "status" &&
            args[1]?.[2] === "--json"
          ) {
            return {
              pid: 1,
              status: 0,
              signal: null,
              stdout: '{"loggedIn":true}',
              stderr: "",
              output: [null, '{"loggedIn":true}', ""],
            };
          }
          return spawnSync(...args);
        });
        syncBuiltinESMExports();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        await withEnvAsync(
          {
            HOME: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
            OPENCLAW_CONFIG_PATH: configPath,
          },
          async () => {
            const { runDoctorLintCli } = await import("./doctor-lint.js");
            const exitCode = await runDoctorLintCli(createTestRuntime(), {
              json: true,
              onlyIds: ["core/doctor/claude-cli"],
            });
            const output: unknown = JSON.parse(
              stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
            );
            const broken = scenario === "cyclic project" || scenario === "blocked workspace";
            expect(exitCode).toBe(broken ? 1 : 0);
            expect(output).toMatchObject({
              ok: !broken,
              checksRun: 1,
              findings: broken
                ? [
                    {
                      checkId: "core/doctor/claude-cli",
                      severity: "warning",
                      message:
                        scenario === "cyclic project"
                          ? `Claude project dir: $OPENCLAW_HOME${projectDir.slice(homeDir.length)} is not readable by this user.`
                          : `Workspace: ${configuredWorkspace} is not readable by this user.`,
                      fixHint:
                        scenario === "cyclic project"
                          ? "- Fix: make the Claude project dir readable, or remove the broken path and let Claude recreate it."
                          : "- Fix: make the workspace a readable, writable directory for the gateway user.",
                    },
                  ]
                : [],
            });
          },
        );
      });
    },
  );
});
