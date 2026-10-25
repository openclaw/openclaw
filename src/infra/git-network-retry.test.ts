import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as execRunner from "../process/exec-runner.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import * as processExec from "../process/exec.js";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { executeGitCommand, executeGitCommandBytes } from "./git-exec.js";
import { buildUpdateCommandRunner, runStep } from "./update-runner-command.js";

const fetch = (options: Parameters<typeof executeGitCommandBytes>[2] = {}) =>
  executeGitCommandBytes("/repo", ["fetch", "origin"], { timeoutMs: 10_000, ...options });
const networkLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...(subsystem === "git/network" ? networkLog : {}),
    }),
  };
});

const failure: SpawnResult = createCommandResult({
  stdout: "partial output",
  stderr: "error: origin did not send all necessary objects",
  code: 1,
});
const success: SpawnResult = { ...failure, stdout: "complete output", stderr: "", code: 0 };

type Attempt = Pick<CommandOptions, "timeoutMs" | "input"> & { argv: string[] };
const calls: Attempt[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  calls.length = 0;
  networkLog.warn.mockClear();
  results(failure);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function results(...attempts: SpawnResult[]) {
  const next = async (argv: string[], options: number | Omit<Attempt, "argv">) => {
    calls.push({ argv, ...(typeof options === "number" ? { timeoutMs: options } : options) });
    const result = attempts.shift();
    if (!result) {
      throw new Error("Unexpected extra Git attempt");
    }
    return result;
  };
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(next);
  vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation(async (argv, options) => {
    const result = await next(argv, options);
    return {
      ...result,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      windowsEncoding: null,
    };
  });
}

it("retries the same object request once without leaking partial output or resetting its budget", async () => {
  results({ ...failure, stderr: `${failure.stderr}\nprivate diagnostic` }, success);
  const input = Buffer.from("0123456789abcdef0123456789abcdef01234567\n");
  const pending = executeGitCommandBytes("/repo", ["fetch", "origin", "--stdin"], {
    input,
    timeoutMs: 10_000,
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect([result.code, result.stdout.toString()]).toEqual([0, "complete output"]);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.argv).toEqual(calls[0]!.argv);
  expect(calls.map((call) => call.input)).toEqual([input, input]);
  expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 9_000]);
  expect(networkLog.warn).toHaveBeenCalledExactlyOnceWith(
    "Git fetch hit a transient failure; retrying once",
    { operation: "fetch", attempt: 1, maxAttempts: 2, delayMs: 1_000, exitCode: 1 },
  );
});

it.each(["direct", "updater"] as const)(
  "cancels %s backoff without another Git process",
  async (route) => {
    const controller = new AbortController();
    const runUpdate =
      route === "updater" ? (await buildUpdateCommandRunner()).runCommand : undefined;
    const pending = runUpdate
      ? withCommandProcessScope(() => runUpdate(["git", "fetch", "origin"], {}), controller.signal)
      : fetch({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await pending).toMatchObject({ termination: "signal", code: null });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([10_000, undefined])(
  "completes an update fetch after an incomplete advertisement (timeout %s)",
  async (timeoutMs) => {
    results(
      { ...failure, stderr: "fatal: transfer closed with 187 bytes remaining to read" },
      success,
    );
    const { runCommand } = await buildUpdateCommandRunner();
    const completed = vi.fn();
    const pending = runStep({
      name: "git-target-inspection-fetch",
      argv: ["git", "-C", "/repo", "--git-dir=/inspection.git", "fetch", "origin"],
      cwd: "/repo",
      timeoutMs,
      runCommand,
      stepIndex: 0,
      totalSteps: 1,
      progress: { onStepComplete: completed },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ exitCode: 0, stdoutTail: "complete output" });
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exitCode: 0 }));
    expect(completed.mock.calls[0]?.[0].failureFacts).toBeUndefined();
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      timeoutMs,
      timeoutMs === undefined ? undefined : 9_000,
    ]);
  },
);

it("does not retry package installation after a transport-like failure", async () => {
  const { runCommand } = await buildUpdateCommandRunner();
  expect(await runCommand(["pnpm", "install"], {})).toEqual(failure);
  expect(calls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["beforeRun", "startRun", "updater"] as const)(
  "rechecks %s authority before retrying",
  async (hook) => {
    const revoked = new Error("operation no longer owns the workspace");
    let current = true;
    const admit = vi.fn(() => {
      if (!current) {
        throw revoked;
      }
    });
    const startRun = async <T>(start: () => T): Promise<Awaited<T>> => {
      await Promise.resolve();
      admit();
      return await start();
    };
    const pending =
      hook === "updater"
        ? (await buildUpdateCommandRunner(undefined, admit)).runCommand(
            ["git", "fetch", "origin"],
            {},
          )
        : fetch(hook === "beforeRun" ? { beforeRun: admit } : { startRun });
    const outcome = expect(pending).rejects.toBe(revoked);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    current = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(admit).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
  },
);

it("recovers transport errors with Git global options", async () => {
  results({ ...failure, stderr: "fatal: Could not resolve host: example.invalid" }, success);
  const pending = executeGitCommand("/repo", ["--git-dir=/repo/.git", "ls-remote", "origin"], {
    timeoutMs: 10_000,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await pending).code).toBe(0);
  expect(calls).toHaveLength(2);
});

it.each([
  [["fetch", "origin"], "fatal: repository not found"],
  [["push", "origin", "main"], failure.stderr],
  [["fetch", "origin"], "error: cannot lock ref: File exists."],
  [["fetch", "origin"], "error: cannot lock ref: is at aaaa but expected bbbb"],
  [["fetch", "origin"], `error: cannot lock ref: is at aaaa but expected bbbb\n${failure.stderr}`],
] satisfies Array<[string[], string]>)(
  "does not replay permanent failures or unsafe operations: %j %s",
  async (args, stderr) => {
    results({ ...failure, stderr });
    expect((await executeGitCommand("/repo", args, { timeoutMs: 10_000 })).code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(networkLog.warn).not.toHaveBeenCalled();
  },
);

it("keeps the existing deadline when the first attempt consumed the retry window", async () => {
  await executeGitCommand("/repo", ["fetch", "origin"], { timeoutMs: 1_000 });
  expect(calls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
