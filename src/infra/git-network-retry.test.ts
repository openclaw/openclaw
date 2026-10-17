import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as execRunner from "../process/exec-runner.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import * as processExec from "../process/exec.js";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { executeGitCommand, executeGitCommandBytes } from "./git-exec.js";
import * as updateGlobal from "./update-global.js";
import { buildUpdateCommandRunner, runStep } from "./update-runner-command.js";

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

describe("Git network recovery", () => {
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
  }

  describe.each([{ name: "worker bytes", execute: executeGitCommandBytes }])(
    "adapter: $name",
    ({ execute }) => {
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
        const pending = execute("/repo", ["fetch", "origin", "--stdin"], {
          input,
          timeoutMs: 10_000,
        });
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
          "Git fetch hit a transient failure; retrying once",
          { operation: "fetch", attempt: 1, maxAttempts: 2, delayMs: 1_000, exitCode: 1 },
        );
      });

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

      it("admits each retry inside the current credential owner", async () => {
        results(failure);
        const rotated = new Error("credential rotated");
        let current = true;
        let admissions = 0;
        const pending = execute("/repo", ["fetch", "origin"], {
          timeoutMs: 10_000,
          startRun: async <T>(start: () => T): Promise<Awaited<T>> => {
            await Promise.resolve();
            admissions += 1;
            if (!current) {
              throw rotated;
            }
            return await start();
          },
        });
        const outcome = expect(pending).rejects.toBe(rotated);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        current = false;
        await vi.advanceTimersByTimeAsync(1_000);
        await outcome;
        expect(admissions).toBe(2);
        expect(calls).toHaveLength(1);
      });
    },
  );

  it.each([
    {
      args: ["--git-dir=/repo/.git", "ls-remote", "origin"],
      stderr: "fatal: Could not resolve host: example.invalid",
    },
    {
      args: ["ls-remote", "origin", "refs/heads/main"],
      stderr:
        "fatal: unable to access 'https://example.invalid/repo.git/': transfer closed with 210 bytes remaining to read",
    },
    {
      args: ["fetch", "origin"],
      stderr:
        "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists.",
    },
  ])("recovers transport errors with Git global options: $stderr", async ({ args, stderr }) => {
    results({ ...failure, stderr }, success);
    const pending = executeGitCommand("/repo", args, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it.each([
    { args: ["fetch", "origin"], stderr: "fatal: repository not found" },
    { args: ["push", "origin", "main"], stderr: failure.stderr },
  ])(
    "does not replay permanent failures or unsafe operations: $args $stderr",
    async ({ args, stderr }) => {
      results({ ...failure, stderr });
      expect((await executeGitCommand("/repo", args, { timeoutMs: 10_000 })).code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(networkLog.warn).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing deadline when the first attempt consumed the retry window", async () => {
    results(failure);
    await executeGitCommand("/repo", ["fetch", "origin"], { timeoutMs: 1_000 });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("installed updater", () => {
    beforeEach(() => {
      vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({
        OPENCLAW_UPDATE_TEST_ENV: "1",
      });
    });

    it.each([
      "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)",
      "error: RPC failed; curl 18 transfer closed with outstanding read data remaining",
    ])("completes the fetch step after a transient download failure: %s", async (stderr) => {
      results({ ...failure, stderr }, success);
      const { runCommand } = await buildUpdateCommandRunner();
      const onStepComplete = vi.fn();
      const pending = runStep({
        name: "git-target-inspection-fetch",
        argv: ["git", "-C", "/repo", "--git-dir=/inspection.git", "fetch", "origin"],
        cwd: "/repo",
        timeoutMs: 10_000,
        stepIndex: 0,
        totalSteps: 1,
        runCommand,
        progress: { onStepComplete },
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toMatchObject({ exitCode: 0, stdoutTail: "complete output" });
      expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 9_000]);
      expect(calls[1]!.argv).toEqual(calls[0]!.argv);
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: "git-target-inspection-fetch", exitCode: 0 }),
      );
    });

    it("preserves an update work step without an explicit deadline", async () => {
      results(failure, success);
      const { runCommand } = await buildUpdateCommandRunner();
      const pending = runCommand(["git", "fetch", "origin"], { cwd: "/repo" });

      await vi.advanceTimersByTimeAsync(1_000);

      expect((await pending).code).toBe(0);
      expect(calls.map((call) => call.timeoutMs)).toEqual([undefined, undefined]);
    });

    it.each(["caller", "scope"] as const)(
      "honors %s cancellation during updater backoff",
      async (source) => {
        results(failure);
        const { runCommand } = await buildUpdateCommandRunner();
        const controller = new AbortController();
        const run = () =>
          runCommand(["git", "fetch", "origin"], {
            timeoutMs: 10_000,
            ...(source === "caller" ? { signal: controller.signal } : {}),
          });
        const pending =
          source === "scope" ? withCommandProcessScope(run, controller.signal) : run();

        await vi.advanceTimersByTimeAsync(100);
        controller.abort();

        expect(await pending).toMatchObject({ code: null, termination: "signal" });
        expect(calls).toHaveLength(1);
      },
    );

    it.each([
      { argv: ["git", "fetch", "origin"], stderr: "fatal: Authentication failed" },
      { argv: ["git", "push", "origin", "main"], stderr: failure.stderr },
      { argv: ["pnpm", "install"], stderr: failure.stderr },
    ])(
      "does not replay permanent failures or other update commands: $argv",
      async ({ argv, stderr }) => {
        results({ ...failure, stderr });
        const { runCommand } = await buildUpdateCommandRunner();

        expect((await runCommand(argv, { timeoutMs: 10_000 })).code).toBe(1);
        expect(calls).toHaveLength(1);
      },
    );
  });
});
