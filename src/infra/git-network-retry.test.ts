import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as execRunner from "../process/exec-runner.js";
import * as processExec from "../process/exec.js";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import {
  executeGitCommand,
  executeGitCommandBuffered,
  executeGitCommandBytes,
} from "./git-exec.js";

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

const failure: SpawnResult = {
  stdout: "partial output",
  stderr: "error: origin did not send all necessary objects",
  termination: "exit",
  code: 1,
  signal: null,
  killed: false,
};
const success: SpawnResult = { ...failure, stdout: "complete output", stderr: "", code: 0 };

describe.each([
  { name: "text", execute: executeGitCommand },
  { name: "worker bytes", execute: executeGitCommandBytes },
  { name: "buffered", execute: executeGitCommandBuffered },
])("Git network recovery ($name)", ({ execute }) => {
  const calls: Array<{ argv: string[]; timeoutMs?: number; input?: string | Uint8Array }> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    calls.length = 0;
    networkLog.warn.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function results(...attempts: SpawnResult[]) {
    const next = (
      argv: string[],
      options: number | Pick<CommandOptions, "timeoutMs" | "input">,
    ) => {
      calls.push({ argv, ...(typeof options === "number" ? { timeoutMs: options } : options) });
      const result = attempts.shift();
      if (!result) {
        throw new Error("Unexpected extra Git attempt");
      }
      return result;
    };
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) =>
      next(argv, options),
    );
    vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation(
      async (argv, options) => {
        const result = next(argv, options);
        return {
          ...result,
          stdout: Buffer.from(result.stdout),
          stderr: Buffer.from(result.stderr),
          windowsEncoding: null,
        };
      },
    );
    vi.spyOn(processExec, "runCommandBuffered").mockImplementation(async (argv, options = {}) => {
      const result = next(argv, options);
      return {
        ...result,
        stdout: Buffer.from(result.stdout),
        stderr: Buffer.from(result.stderr),
        termination: result.termination === "no-output-timeout" ? "timeout" : result.termination,
      };
    });
  }

  it("retries the same object request once without leaking partial output or resetting its budget", async () => {
    results(
      {
        ...failure,
        stderr:
          "error: origin did not send all necessary objects\nprivate diagnostic must not be logged",
      },
      success,
    );
    const input = Buffer.from("0123456789abcdef0123456789abcdef01234567\n");
    const pending = execute("/repo", ["fetch", "origin", "--stdin"], { input, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("complete output");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).toEqual(calls[0]!.argv);
    expect(calls.map((call) => call.input)).toEqual([input, input]);
    expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 9_000]);
    expect(networkLog.warn).toHaveBeenCalledExactlyOnceWith(
      "Git fetch hit a transient transport failure; retrying once",
      { operation: "fetch", attempt: 1, maxAttempts: 2, delayMs: 1_000, exitCode: 1 },
    );
  });

  it("surfaces the second failure without a third attempt", async () => {
    results(failure, { ...failure, stderr: "fatal: connection reset by peer" });
    const pending = execute("/repo", ["ls-remote", "origin"], { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.code).toBe(1);
    expect(result.stderr.toString()).toBe("fatal: connection reset by peer");
    expect(calls).toHaveLength(2);
  });

  it.each([
    {
      args: ["-c", "credential.helper=", "fetch", "origin"],
      stderr: "fatal: unable to access remote: The requested URL returned error: 503",
    },
    {
      args: ["--git-dir=/repo/.git", "ls-remote", "origin"],
      stderr: "fatal: Could not resolve host: example.invalid",
    },
    {
      args: ["-C", "/repo", "fetch", "origin"],
      stderr: "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
    },
  ])("recovers transport errors with Git global options: $stderr", async ({ args, stderr }) => {
    results({ ...failure, stderr }, success);
    const pending = execute("/repo", args, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it.each([
    {
      args: ["fetch", "origin"],
      stderr: "fatal: Authentication failed; remote returned error: 503",
    },
    { args: ["fetch", "origin"], stderr: "fatal: repository not found" },
    { args: ["fetch", "origin"], stderr: "fatal: couldn't find remote ref main" },
    {
      args: ["fetch", "origin"],
      stderr: "fatal: No space left on device\nerror: origin did not send all necessary objects",
    },
    { args: ["push", "origin", "main"], stderr: failure.stderr },
    { args: ["pull", "origin", "main"], stderr: failure.stderr },
    { args: ["clone", "remote", "target"], stderr: failure.stderr },
    { args: ["config", "example.value", "fetch"], stderr: failure.stderr },
    { args: ["-c", "alias.fetch=fetch", "status"], stderr: failure.stderr },
  ])(
    "does not replay permanent failures or unsafe operations: $args $stderr",
    async ({ args, stderr }) => {
      results({ ...failure, stderr });
      expect((await execute("/repo", args, { timeoutMs: 10_000 })).code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(networkLog.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { termination: "timeout", code: 124 },
    { termination: "signal", signal: "SIGTERM" },
    { outputLimitExceeded: true },
    { outputErrorStream: "stderr" },
    { cleanup: "uncertain" },
  ] satisfies Partial<SpawnResult>[])(
    "does not replay interrupted or incomplete process results: %j",
    async (metadata) => {
      results({ ...failure, ...metadata });
      await execute("/repo", ["fetch", "origin"], { timeoutMs: 10_000 });
      expect(calls).toHaveLength(1);
    },
  );

  it("cancels during backoff without starting another Git process", async () => {
    results(failure);
    const controller = new AbortController();
    const pending = execute("/repo", ["fetch", "origin"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await pending).toMatchObject({ termination: "signal", code: null });
    expect(calls).toHaveLength(1);
  });

  it("rechecks authority before retrying", async () => {
    results(failure);
    const revoked = new Error("operation no longer owns the workspace");
    const beforeRun = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw revoked;
      });
    const pending = execute("/repo", ["fetch", "origin"], { timeoutMs: 10_000, beforeRun });
    const outcome = expect(pending).rejects.toBe(revoked);
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(calls).toHaveLength(1);
  });

  it("keeps the existing deadline when the first attempt consumed the retry window", async () => {
    results(failure);
    await execute("/repo", ["fetch", "origin"], { timeoutMs: 1_000 });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
