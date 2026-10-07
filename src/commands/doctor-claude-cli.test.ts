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

const defaultClaudeConfig = {
  agents: {
    defaults: { model: { primary: "claude-cli/claude-sonnet-4-6" } },
    entries: { main: {} },
  },
};

async function withTempHome<T>(
  run: (params: { homeDir: string; workspaceDir: string; commandPath: string }) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-claude-cli-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  const commandPath = path.join(binDir, "claude");
  fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    return await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
        PATH: binDir,
      },
      () => Promise.resolve(run({ homeDir, workspaceDir, commandPath })),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function mockClaudeAuthentication(loggedIn: boolean) {
  const stdout = JSON.stringify({ loggedIn });
  const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout,
    stderr: "",
    output: [null, stdout, ""],
  });
  syncBuiltinESMExports();
  return spawn;
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
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
    clearHealthChecksForTest();
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

  it("probes auth with the same cleared environment as Claude execution", async () => {
    await withTempHome(({ workspaceDir, commandPath }) => {
      resolveCliBackendConfigMock.mockReturnValue({
        id: "claude-cli",
        pluginId: "anthropic",
        config: {
          command: "claude",
          clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
      });
      const spawn = mockClaudeAuthentication(true);
      vi.stubEnv("ANTHROPIC_API_KEY", "ambient-api-key");
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth-token");
      vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-config");

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: "claude-cli/claude-sonnet-4-6" },
            entries: { main: {} },
          },
        },
        {
          workspaceDir,
          noteFn: vi.fn(),
        },
      );

      expect(spawn).toHaveBeenCalledWith(
        commandPath,
        ["auth", "status", "--json"],
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CONFIG_DIR: "/tmp/claude-config",
            PATH: path.dirname(commandPath),
          }),
        }),
      );
      const authEnv = spawn.mock.calls[0]?.[2]?.env;
      expect(authEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(authEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    });
  });

  it("points at the import for excluded Claude auto memory until the workspace has one", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
      const memoryDir = path.join(projectDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "- [Fact](fact.md)\n");
      fs.writeFileSync(path.join(memoryDir, "fact.md"), "fact\n");
      mockClaudeAuthentication(true);

      const noteFn = vi.fn();
      noteClaudeCliHealth(defaultClaudeConfig, { workspaceDir, noteFn });
      const body = noteBody(noteFn);
      expect(body).toContain("Claude Code memory: 2 file(s)");
      expect(body).toContain(`openclaw migrate claude --agent main --from ${memoryDir}`);
      expect(body).not.toContain("- Fix:");

      const optedOut = vi.fn();
      noteClaudeCliHealth(
        {
          ...defaultClaudeConfig,
          plugins: {
            entries: { anthropic: { config: { claudeCli: { excludeNativeMemory: false } } } },
          },
        },
        { workspaceDir, noteFn: optedOut },
      );
      expect(optedOut).not.toHaveBeenCalled();

      fs.mkdirSync(path.join(workspaceDir, "memory", "imports", "claude-code"), {
        recursive: true,
      });
      const imported = vi.fn();
      noteClaudeCliHealth(defaultClaudeConfig, { workspaceDir, noteFn: imported });
      expect(imported).not.toHaveBeenCalled();
    });
  });

  it("reports when Claude CLI owns no active login", async () => {
    await withTempHome(({ workspaceDir }) => {
      const noteFn = vi.fn();
      mockClaudeAuthentication(false);
      noteClaudeCliHealth(defaultClaudeConfig, {
        workspaceDir,
        noteFn,
      });

      const body = noteBody(noteFn);
      expect(body).toContain("Claude auth: not logged in.");
      expect(body).toContain("claude auth login");
      expect(body).not.toContain("openclaw models auth login");
    });
  });

  it("warns when the Claude binary is missing", async () => {
    await withTempHome(({ workspaceDir, commandPath }) => {
      fs.rmSync(commandPath);
      const noteFn = vi.fn();
      noteClaudeCliHealth(defaultClaudeConfig, {
        workspaceDir,
        noteFn,
      });

      const body = noteBody(noteFn);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).toContain("install Claude CLI on PATH for the gateway user");
      expect(body).not.toContain("claude auth login");
    });
  });

  it("lists Claude CLI agents only when a problem is reported", async () => {
    await withTempHome(({ workspaceDir }) => {
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
      mockClaudeAuthentication(true);

      noteClaudeCliHealth(
        {
          agents: {
            defaults: { model: { primary: runtimeModel } },
            entries: {
              zeta: {
                workspace: zetaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
              alpha: {
                workspace: alphaWorkspace,
                model: runtimeModel,
                models: { [runtimeModel]: { agentRuntime: { id: "claude-cli" } } },
              },
            },
          },
        },
        {
          noteFn,
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
  it.each(["cyclic project", "native installation", "excluded native memory"])(
    "doctor --lint --only core/doctor/claude-cli reports %s at final output",
    async (scenario) => {
      clearHealthChecksForTest();
      await withTempHome(async ({ homeDir, workspaceDir, commandPath }) => {
        const configPath = path.join(homeDir, "openclaw.json");
        const projectDir = resolveClaudeCliProjectDirForWorkspace({
          workspaceDir,
          homeDir,
        });
        fs.mkdirSync(path.dirname(projectDir), { recursive: true });
        if (scenario === "cyclic project") {
          fs.symlinkSync(projectDir, projectDir, process.platform === "win32" ? "junction" : "dir");
        } else if (scenario === "excluded native memory") {
          // The import reminder is advisory: lint must stay clean.
          fs.mkdirSync(path.join(projectDir, "memory"), { recursive: true });
          fs.writeFileSync(path.join(projectDir, "memory", "MEMORY.md"), "- fact\n");
        }
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            agents: {
              ownership: "explicit",
              defaults: {
                model: "anthropic/fixture",
                models: { "anthropic/fixture": { agentRuntime: { id: "claude-cli" } } },
                workspace: workspaceDir,
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
        let probeCommand = process.execPath;
        if (scenario === "native installation") {
          probeCommand = path.join(homeDir, ".local", "bin", "claude");
          fs.mkdirSync(path.dirname(probeCommand), { recursive: true });
          fs.renameSync(commandPath, probeCommand);
        }
        resolveCliBackendConfigMock.mockReturnValue({
          id: "claude-cli",
          config: { command: scenario === "native installation" ? "claude" : probeCommand },
        });
        const spawnSync = childProcess.spawnSync;
        vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
          if (
            args[0] === probeCommand &&
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
            const broken = scenario === "cyclic project";
            expect(exitCode).toBe(broken ? 1 : 0);
            expect(output).toMatchObject({
              ok: !broken,
              checksRun: 1,
              findings: broken
                ? [
                    {
                      checkId: "core/doctor/claude-cli",
                      severity: "warning",
                      message: `Claude project dir: $OPENCLAW_HOME${projectDir.slice(homeDir.length)} is not readable by this user.`,
                      fixHint:
                        "- Fix: make the Claude project dir readable, or remove the broken path and let Claude recreate it.",
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
