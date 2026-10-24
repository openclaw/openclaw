import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let homeDir: string;
let workspaceDir: string;
let commandPath: string;
beforeEach(() => {
  const root = tempDirs.make("openclaw-doctor-claude-cli-");
  homeDir = path.join(root, "home");
  workspaceDir = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  [homeDir, workspaceDir, binDir].forEach((dir) => fs.mkdirSync(dir));
  commandPath = path.join(binDir, "claude");
  fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("OPENCLAW_HOME", homeDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeDir, ".openclaw"));
  vi.stubEnv("PATH", binDir);
});

function authResult(loggedIn: boolean) {
  const stdout = JSON.stringify({ loggedIn });
  return { pid: 1, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] };
}

function mockClaudeAuthentication(loggedIn: boolean) {
  const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue(authResult(loggedIn));
  syncBuiltinESMExports();
  return spawn;
}

function noteText(noteFn: ReturnType<typeof vi.fn>, index = 0): string {
  const value: unknown = noteFn.mock.calls[0]?.at(index);
  if (typeof value !== "string") {
    throw new Error("Expected note text");
  }
  return value;
}

function checkHealth() {
  const noteFn = vi.fn();
  noteClaudeCliHealth(defaultClaudeConfig, { workspaceDir, noteFn });
  return noteText(noteFn);
}

function runtimeAgent(workspace: string, model: string) {
  return { workspace, model, models: { [model]: { agentRuntime: { id: "claude-cli" } } } };
}

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
  noteClaudeCliHealth({}, { noteFn });
  expect(noteFn).not.toHaveBeenCalled();
});

it("probes auth with the same cleared environment as Claude execution", () => {
  resolveCliBackendConfigMock.mockReturnValue({
    id: "claude-cli",
    pluginId: "anthropic",
    config: { command: "claude", clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
  });
  const spawn = mockClaudeAuthentication(true);
  vi.stubEnv("ANTHROPIC_API_KEY", "ambient-api-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth-token");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-config");

  noteClaudeCliHealth(
    {
      agents: {
        ...defaultClaudeConfig.agents,
        defaults: { model: "claude-cli/claude-sonnet-4-6" },
      },
    },
    { workspaceDir, noteFn: vi.fn() },
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

it.each([0, 1])("reports when Claude CLI owns no active login (exit %i)", (status) => {
  mockClaudeAuthentication(false).mockReturnValue({ ...authResult(false), status });
  const body = checkHealth();
  expect(body).toContain("Claude auth: not logged in.");
  expect(body).toContain("claude auth login");
  expect(body).not.toContain("openclaw models auth login");
});

it.each([
  {
    scenario: "a failed subprocess",
    result: {
      ...authResult(true),
      status: null,
      error: Object.assign(new Error("synthetic auth status timeout"), { code: "ETIMEDOUT" }),
    },
  },
  { scenario: "invalid JSON", result: { ...authResult(true), stdout: "not JSON" } },
  { scenario: "an inconclusive response", result: { ...authResult(true), stdout: "{}" } },
  { scenario: "an unsuccessful status", result: { ...authResult(true), status: 1 } },
])("does not report a logged-out login for $scenario", ({ result }) => {
  vi.spyOn(childProcess, "spawnSync").mockReturnValue(result);
  syncBuiltinESMExports();
  const body = checkHealth();
  expect(body).toContain("Claude auth: status check unavailable.");
  expect(body).toContain("claude auth status --json");
  expect(body).not.toContain("not logged in");
  expect(body).not.toContain("claude auth login");
});

it("warns when the Claude binary is missing", () => {
  fs.rmSync(commandPath);
  const body = checkHealth();
  expect(body).toContain('Binary: command "claude" was not found on PATH.');
  expect(body).toContain("install Claude CLI on PATH for the gateway user");
  expect(body).not.toContain("claude auth login");
});

it("lists Claude CLI agents only when a problem is reported", () => {
  resolveModelAgentRuntimeMetadataMock.mockReturnValue({ id: "claude-cli", source: "model" });
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
          zeta: runtimeAgent(zetaWorkspace, runtimeModel),
          alpha: runtimeAgent(alphaWorkspace, runtimeModel),
        },
      },
    },
    { noteFn },
  );

  expect(noteText(noteFn, 1)).toBe("Claude CLI");
  const body = noteText(noteFn);
  expect(body).toContain(`Agent alpha workspace: ${alphaWorkspace} exists but is not a directory.`);
  expect(body).toContain("Agents using Claude CLI: alpha, zeta.");
  expect(body).not.toContain(`Agent zeta workspace: ${zetaWorkspace}`);
});

it.each(["cyclic project", "native installation"])(
  "doctor --lint --only core/doctor/claude-cli reports %s at final output",
  async (scenario) => {
    clearHealthChecksForTest();
    const configPath = path.join(homeDir, "openclaw.json");
    const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir });
    fs.mkdirSync(path.dirname(projectDir), { recursive: true });
    if (scenario === "cyclic project") {
      fs.symlinkSync(projectDir, projectDir, process.platform === "win32" ? "junction" : "dir");
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: runtimeAgent(workspaceDir, "anthropic/fixture"),
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
        return authResult(true);
      }
      return spawnSync(...args);
    });
    syncBuiltinESMExports();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const { runDoctorLintCli } = await import("./doctor-lint.js");
    const exitCode = await runDoctorLintCli(createTestRuntime(), {
      json: true,
      onlyIds: ["core/doctor/claude-cli"],
    });
    const output: unknown = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
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
