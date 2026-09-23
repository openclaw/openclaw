import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  optional: false,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/cross-os-release-checks/config.ts")>()),
  get CROSS_OS_AGENT_TURN_OPTIONAL() {
    return command.optional;
  },
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
    command.optional = false;
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

  function expectInvocation(attempt: number) {
    const [invocation, options] = command.run.mock.calls[attempt - 1]!;
    const args = invocation.args.slice(adapter === "packaged" ? 1 : 0);
    expect(args).toEqual([
      "agent",
      "--agent",
      "main",
      "--session-id",
      expect.stringMatching(new RegExp(`^cross-os-release-check-probe-[0-9a-f-]{36}-${attempt}$`)),
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
    expectInvocation(1);
  });

  it("rejects stale OK output and accepts only the retry's new log window", async () => {
    writeFileSync(logPath, '{"payloads":[{"text":"OK"}]}\n');
    const loggedSuccess = { exitCode: 0, stdout: "", stderr: "" };
    command.run.mockImplementation(async () => {
      if (command.run.mock.calls.length === 2) {
        expect(readFileSync(logPath, "utf8")).toContain(
          `retrying ${adapter === "installed" ? "installed agent turn" : "agent turn"} after retryable live failure: Agent output did not contain the expected OK marker.`,
        );
        appendFileSync(logPath, '{"payloads":[{"text":"OK"}]}\n');
      }
      return loggedSuccess;
    });

    await expect(run()).resolves.toBe(loggedSuccess);
    expect(command.run).toHaveBeenCalledTimes(2);
    expect(expectInvocation(1)).not.toBe(expectInvocation(2));
  });

  it("preserves a nonretryable failure without another command", async () => {
    const error = new Error("document-extract: failed to install bundled runtime deps");
    command.run.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(command.run).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("exhausts both attempts before optional=%s handling", async (optional) => {
    command.optional = optional;
    const firstError = new Error("HTTP 503: upstream connect error");
    const lastError = new Error("gateway request timeout for agent after 210000ms");
    command.run.mockRejectedValueOnce(firstError).mockImplementationOnce(async () => {
      expect(readFileSync(logPath, "utf8")).toContain(firstError.message);
      throw lastError;
    });

    if (optional) {
      await expect(run()).resolves.toEqual({
        status: 0,
        stdout: JSON.stringify({
          status: "skipped",
          reason: "cross-os live agent turn unavailable after retry",
        }),
        stderr: "",
      });
      expect(readFileSync(logPath, "utf8")).toContain("skipping optional cross-OS live agent turn");
    } else {
      await expect(run()).rejects.toBe(lastError);
      expect(readFileSync(logPath, "utf8")).not.toContain("skipping optional");
    }
    expect(command.run).toHaveBeenCalledTimes(2);
    expect(expectInvocation(1)).not.toBe(expectInvocation(2));
  });
});
