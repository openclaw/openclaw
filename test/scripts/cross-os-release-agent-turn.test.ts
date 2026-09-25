import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandInvocation,
  CommandOptions,
  CommandResult,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS } from "../../scripts/lib/cross-os-release-checks/config.ts";
import { runInstalledAgentTurn } from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { runAgentTurn } from "../../scripts/lib/cross-os-release-checks/runtime.ts";

const command = vi.hoisted(() => ({
  run: vi.fn<(invocation: CommandInvocation, options: CommandOptions) => Promise<CommandResult>>(),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/process.ts")
  >()),
  runCommand: (executable: string, args: string[], options: CommandOptions) =>
    command.run({ command: executable, args, shell: false }, options),
  runCommandInvocation: command.run,
}));

describe.each(["packaged", "installed"] as const)("%s release agent turn", (adapter) => {
  let dir: string;
  let logPath: string;
  const env = { RELEASE_TEST: "1" };
  const success = { exitCode: 0, stdout: "OK", stderr: "" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cross-os-release-agent-"));
    logPath = join(dir, "agent.log");
    command.run.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run() {
    const params = { env, label: "probe", logPath };
    return adapter === "installed"
      ? runInstalledAgentTurn({ ...params, cliPath: join(dir, "openclaw"), cwd: dir })
      : runAgentTurn({
          ...params,
          lane: {
            name: "probe",
            rootDir: dir,
            prefixDir: join(dir, "prefix"),
            homeDir: dir,
            stateDir: join(dir, "state"),
            appDataDir: join(dir, "app-data"),
            gatewayPort: 18_789,
            phaseTimings: [],
          },
        });
  }

  function expectInvocation() {
    const [invocation, options] = command.run.mock.calls[0]!;
    const args = invocation.args.slice(adapter === "packaged" ? 1 : 0);
    expect(args).toEqual([
      "agent",
      "--agent",
      "main",
      "--session-id",
      expect.stringMatching(/^cross-os-release-check-probe-[0-9a-f-]{36}$/u),
      "--message",
      "Reply with exact ASCII text OK only.",
      "--thinking",
      "off",
      "--timeout",
      String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
      "--json",
    ]);
    expect(invocation.command).toBe(
      adapter === "packaged" ? process.execPath : join(dir, "openclaw"),
    );
    if (adapter === "packaged") {
      expect(invocation.args[0]).toBe(
        join(
          dir,
          "prefix",
          ...(process.platform === "win32" ? [] : ["lib"]),
          "node_modules",
          "openclaw",
          "openclaw.mjs",
        ),
      );
    }
    expect(options).toEqual({
      cwd: dir,
      env,
      logPath,
      timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      check: true,
    });
    expect(options.env).toBe(env);
    return args[4];
  }

  it("returns the command result with the exact agent invocation", async () => {
    command.run.mockResolvedValue(success);
    await expect(run()).resolves.toBe(success);
    expect(command.run).toHaveBeenCalledTimes(1);
    expectInvocation();
  });

  it("rejects stale OK output without another command", async () => {
    writeFileSync(logPath, '{"payloads":[{"text":"OK"}]}\n');
    command.run.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    command.run.mockResolvedValueOnce(success);

    await expect(run()).rejects.toThrow("Agent output did not contain the expected OK marker.");
    expect(command.run).toHaveBeenCalledTimes(1);
  });

  it("accepts OK from the current command's log window", async () => {
    writeFileSync(logPath, '{"payloads":[{"text":"stale"}]}\n');
    const loggedSuccess = { exitCode: 0, stdout: "", stderr: "" };
    command.run.mockImplementation(async () => {
      appendFileSync(logPath, '{"payloads":[{"text":"OK"}]}\n');
      return loggedSuccess;
    });

    await expect(run()).resolves.toBe(loggedSuccess);
    expect(command.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "document-extract: failed to install bundled runtime deps",
    "HTTP 503: upstream connect error",
    "gateway request timeout for agent after 210000ms",
    "The model did not produce a response before the model idle timeout.",
  ])("preserves the first failure without another command: %s", async (message) => {
    const error = new Error(message);
    command.run.mockRejectedValueOnce(error).mockResolvedValueOnce(success);
    await expect(run()).rejects.toBe(error);
    expect(command.run).toHaveBeenCalledTimes(1);
  });
});
