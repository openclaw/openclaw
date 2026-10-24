import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runReleaseAgentTurn } from "../../scripts/lib/cross-os-release-checks/agent.ts";
import {
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  type CommandResult,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const runCommand = vi.fn<(args: string[], timeoutMs: number) => Promise<CommandResult>>();

let logPath: string;
const temporary = useAutoCleanupTempDirTracker(afterEach);
const success = { exitCode: 0, stdout: "OK", stderr: "" };

beforeEach(() => {
  logPath = join(temporary.make("cross-os-release-agent-"), "agent.log");
  runCommand.mockReset().mockResolvedValue(success);
});

const run = () => runReleaseAgentTurn({ label: "probe", logPath }, runCommand);

it("uses an isolated session and a bounded command", async () => {
  await expect(run()).resolves.toBe(success);
  expect(runCommand).toHaveBeenCalledOnce();
  const [args, timeout] = runCommand.mock.calls[0]!;
  expect(args[args.indexOf("--session-id") + 1]).toMatch(
    /^cross-os-release-check-probe-[0-9a-f-]{36}$/u,
  );
  expect(timeout).toBe((CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000);
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
