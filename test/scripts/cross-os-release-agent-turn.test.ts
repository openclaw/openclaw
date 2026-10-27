import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  type CommandInvocation,
  type CommandOptions,
  type CommandResult,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { runInstalledAgentTurn } from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { runAgentTurn } from "../../scripts/lib/cross-os-release-checks/runtime.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeReleaseLane } from "./release-lane.test-support.ts";

const runCommand = vi.hoisted(() =>
  vi.fn<(invocation: CommandInvocation, options: CommandOptions) => Promise<CommandResult>>(),
);

vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/process.ts")
  >()),
  runCommand: (executable: string, args: string[], options: CommandOptions) =>
    runCommand({ command: executable, args, shell: false }, options),
  runCommandInvocation: runCommand,
}));

let dir: string;
let logPath: string;
const temporary = useAutoCleanupTempDirTracker(afterEach);
const env = { RELEASE_TEST: "1" };
const success = { exitCode: 0, stdout: "OK", stderr: "" };

beforeEach(() => {
  dir = temporary.make("cross-os-release-agent-");
  logPath = join(dir, "agent.log");
  runCommand.mockReset().mockResolvedValue(success);
});

function run(adapter: "packaged" | "installed" = "packaged") {
  const params = { env, label: "probe", logPath };
  return adapter === "installed"
    ? runInstalledAgentTurn({ ...params, cliPath: join(dir, "openclaw"), cwd: dir })
    : runAgentTurn({
        ...params,
        lane: makeReleaseLane(dir, {
          name: "probe",
          prefixDir: join(dir, "prefix"),
          stateDir: join(dir, "state"),
          appDataDir: join(dir, "app-data"),
          gatewayPort: 18_789,
        }),
      });
}

it.each(["packaged", "installed"] as const)("uses the exact %s invocation", async (adapter) => {
  await expect(run(adapter)).resolves.toBe(success);
  const prefix = process.platform === "win32" ? "prefix" : "prefix/lib";
  const entry = join(dir, prefix, "node_modules/openclaw/openclaw.mjs");
  expect(runCommand).toHaveBeenCalledExactlyOnceWith(
    {
      command: adapter === "packaged" ? process.execPath : join(dir, "openclaw"),
      shell: false,
      args: [
        ...(adapter === "packaged" ? [entry] : []),
        ..."agent --agent main --session-id".split(" "),
        expect.stringMatching(/^cross-os-release-check-probe-[0-9a-f-]{36}$/u),
        "--message",
        "Reply with exact ASCII text OK only.",
        ..."--thinking off --timeout".split(" "),
        String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
        "--json",
      ],
    },
    {
      cwd: dir,
      env,
      logPath,
      timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      check: true,
    },
  );
  expect(runCommand.mock.calls[0]![1].env).toBe(env);
});

it.each([false, true])("accepts only current-command log output: %s", async (current) => {
  const loggedSuccess = { ...success, stdout: "" };
  writeFileSync(logPath, JSON.stringify({ payloads: [{ text: current ? "stale" : "OK" }] }) + "\n");
  runCommand.mockImplementationOnce(async () => {
    if (current) {
      appendFileSync(logPath, '{"payloads":[{"text":"OK"}]}\n');
    }
    return loggedSuccess;
  });
  const result = run();
  if (current) {
    await expect(result).resolves.toBe(loggedSuccess);
  } else {
    await expect(result).rejects.toThrow("Agent output did not contain the expected OK marker.");
  }
  expect(runCommand).toHaveBeenCalledTimes(1);
});

it("preserves the first failure without another command", async () => {
  const error = new Error("HTTP 503: upstream connect error");
  runCommand.mockRejectedValueOnce(error);
  await expect(run()).rejects.toBe(error);
  expect(runCommand).toHaveBeenCalledTimes(1);
});
