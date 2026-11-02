import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { requireGitBuffer } from "../agents/worktrees/git.js";
import { readCommandProcessFailure } from "../process/exec-result.js";
import * as processRunner from "../process/exec-runner.js";
import * as processExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as diagnosticEvents from "./diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import {
  createGitCommandError,
  enqueueGitRefMutation,
  executeGitCommand,
  executeGitCommandBuffered,
  executeGitCommandBytes,
  GitCommandTimeoutError,
  gitNullConfigPath,
  normalizeGitPathForFilesystem,
  requireGitCommand,
  requireGitCommandOutput,
} from "./git-exec.js";

const refLogs = vi.hoisted(() => ({ info: vi.fn(), isEnabled: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...(subsystem === "git/ref-mutation" ? refLogs : {}),
    }),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("Git ref mutation timing", () => {
  let clock = 0;
  let clockEpoch = 0;
  const traces: Array<DiagnosticTraceContext | undefined> = [];
  const processMetadata = { pid: process.pid, threadId, isMainThread };
  const mutate = (run: Parameters<typeof enqueueGitRefMutation>[2]) =>
    enqueueGitRefMutation("/private/repository", ".git", run);
  const expectTiming = (fields: Record<string, unknown>) =>
    expect(refLogs.info).toHaveBeenCalledExactlyOnceWith("slow Git ref mutation", {
      ...processMetadata,
      durationMs: 1_000,
      omittedObservations: 0,
      ...fields,
    });

  beforeEach(() => {
    // Advance past the previous owner's window without resetting its live singleton.
    clockEpoch += 120_000;
    clock = clockEpoch;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(diagnosticEvents, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    vi.spyOn(fs, "realpath").mockImplementation(async (filename) => String(filename));
    refLogs.isEnabled.mockReset().mockReturnValue(true);
    refLogs.info.mockReset().mockImplementation(() => {
      traces.push(getActiveDiagnosticTraceContext());
    });
    traces.length = 0;
  });

  it("attributes resolution, queue wait, callback work and trace context separately", async () => {
    const holderGate = createEnteredGate();
    const callbackEntered = createDeferred();
    const releaseCallback = createDeferred();
    const abort = new AbortController();
    const trace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: "01",
    };
    const result = { privateResult: "refs/private/result" };
    vi.mocked(diagnosticEvents.areDiagnosticsEnabledForProcess).mockReturnValue(false);
    vi.mocked(fs.realpath).mockResolvedValueOnce("/private/shared.git");
    const holder = enqueueGitRefMutation("/private/holder", ".git", holderGate.wait);
    const pending: Promise<unknown>[] = [holder];
    try {
      await holderGate.entered;
      vi.mocked(diagnosticEvents.areDiagnosticsEnabledForProcess).mockReturnValue(true);
      vi.mocked(fs.realpath).mockImplementationOnce(async () => {
        clock += 25;
        return "/private/shared.git";
      });
      const queued = runWithDiagnosticTraceContext(trace, () =>
        enqueueGitRefMutation(
          "/private/linked-checkout",
          "../shared.git",
          async () => {
            callbackEntered.resolve();
            await releaseCallback.promise;
            clock += 175;
            return result;
          },
          abort.signal,
        ),
      );
      const settled = vi.fn();
      void queued.then(settled, settled);
      pending.push(queued);
      await nextTurn();
      expect(refLogs.info).not.toHaveBeenCalled();
      clock += 1_200;
      holderGate.release();
      await callbackEntered.promise;
      abort.abort(new Error("cancelled after ref mutation started"));
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      releaseCallback.resolve();
      await expect(queued).resolves.toBe(result);
      expectTiming({
        durationMs: 1_400,
        resolveMs: 25,
        queueWaitMs: 1_200,
        queuedOperationMs: 175,
        callbackEntered: true,
        outcome: "returned",
      });
      expect(traces).toEqual([trace]);
    } finally {
      holderGate.release();
      releaseCallback.resolve();
      await Promise.allSettled(pending);
    }
  });

  it.each(["resolution", "callback"] as const)(
    "preserves the original %s failure without private diagnostic content",
    async (phase) => {
      const error = new Error("failed update-ref refs/private at /private/repository");
      const fail = () => {
        clock += 1_000;
        throw error;
      };
      const callback = vi.fn(async () => fail());
      const resolving = phase === "resolution";
      if (resolving) {
        vi.mocked(fs.realpath).mockImplementationOnce(async () => fail());
      }
      const operation = resolving
        ? runWithDiagnosticTraceContext(undefined, () =>
            enqueueGitRefMutation("/private/repository", "refs/private", callback),
          )
        : mutate(callback);
      await expect(operation).rejects.toBe(error);
      expectTiming(
        resolving
          ? { resolveMs: 1_000, callbackEntered: false, outcome: "threw" }
          : {
              resolveMs: 0,
              queueWaitMs: 0,
              queuedOperationMs: 1_000,
              callbackEntered: true,
              outcome: "threw",
            },
      );
      if (resolving) {
        expect(callback).not.toHaveBeenCalled();
        expect(traces).toEqual([undefined]);
      } else {
        const next = { next: true };
        await expect(mutate(async () => next)).resolves.toBe(next);
      }
    },
  );

  it.each(["returned", "threw"] as const)(
    "preserves the %s outcome when the diagnostic sink throws",
    async (outcome) => {
      const original = new Error("original outcome");
      refLogs.info.mockImplementation(() => {
        throw new Error("diagnostic sink failed");
      });
      const operation = mutate(async () => {
        clock += 1_000;
        if (outcome === "threw") {
          throw original;
        }
        return original;
      });
      if (outcome === "threw") {
        await expect(operation).rejects.toBe(original);
      } else {
        await expect(operation).resolves.toBe(original);
      }
      expect(refLogs.info).toHaveBeenCalledOnce();
    },
  );

  it("bounds records across different directories and reports omissions in the next window", async () => {
    const allEntered = createDeferred();
    const release = createDeferred();
    let entered = 0;
    const pending = Array.from({ length: 64 }, (_, index) =>
      enqueueGitRefMutation(`/private/repository-${index}`, ".git", async () => {
        entered += 1;
        if (entered === 64) {
          allEntered.resolve();
        }
        await release.promise;
        return index;
      }),
    );
    try {
      await allEntered.promise;
      clock += 1_000;
      release.resolve();
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 64 }, (_, index) => index));
      expect(refLogs.info).toHaveBeenCalledTimes(60);
      clock += 60_000;
      for (const [count, omittedObservations] of [
        [61, 4],
        [62, 0],
      ] as const) {
        await enqueueGitRefMutation("/private/next-window", ".git", async () => {
          clock += 1_000;
        });
        expect(refLogs.info).toHaveBeenCalledTimes(count);
        expect(refLogs.info.mock.lastCall?.[1]).toMatchObject({ omittedObservations });
      }
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });
});

it.each([
  { input: "/C", expected: "C:\\" },
  { input: "relative/repo", expected: "relative/repo" },
])("normalizes only standard MSYS drive paths on Windows: $input", ({ input, expected }) => {
  expect(normalizeGitPathForFilesystem(input, "win32")).toBe(expected);
});

it("overrides maintenance.autoDetach only for an explicitly owned Git command", async () => {
  const key = "maintenance.autoDetach";
  await withTestDir({ prefix: "openclaw-git-exec-maintenance-" }, async (root) => {
    const env = { GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined };
    await requireGitCommand(root, ["init"], { env });
    await requireGitCommand(root, ["config", key, "true"], { env });
    const owned = await executeGitCommand(root, ["config", "--get", key], {
      env,
      killProcessTree: true,
    });
    expect(owned.code).toBe(0);
    expect(owned.stdout.trim()).toBe("false");
    await expect(requireGitCommand(root, ["config", "--get", key], { env })).resolves.toBe("true");
  });
});

it("reports the applied 120-second Git timeout", async () => {
  const seconds = 120;
  const commandSpy = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockResolvedValue(createCommandResult({ termination: "timeout", code: 124 }));
  const args = ["worktree", "add"];
  const result = await executeGitCommand("/repo", args, { timeoutMs: undefined });
  const label = `timed out after ${seconds} seconds`;
  const error = createGitCommandError("git worktree add", result);
  expect(error).toBeInstanceOf(GitCommandTimeoutError);
  const message = error.message;
  expect(message).toContain(label);
  expect(message).toContain(
    `Git did not finish within its ${seconds}s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).`,
  );
  await expect(requireGitCommand("/repo", args, { timeoutMs: undefined })).rejects.toThrow(label);
  expect(
    commandSpy.mock.calls.map(([, options]) =>
      typeof options === "number" ? options : options.timeoutMs,
    ),
  ).toEqual([seconds * 1000, seconds * 1000]);
});

it("honors explicit Git execution placement while defaulting to Gateway work", async () => {
  const text = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockResolvedValue(createCommandResult());
  const bytes = vi.spyOn(processRunner, "runCommandBuffersWithTimeout").mockResolvedValue({
    ...createCommandResult(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    windowsEncoding: null,
  });
  const buffered = vi.spyOn(processExec, "runCommandBuffered").mockResolvedValue({
    ...createCommandResult(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  for (const executionIntent of [undefined, "agent-tool"] as const) {
    const options = { executionIntent, timeoutMs: 1_000 };
    for (const waitForExit of [false, true]) {
      await executeGitCommand("/repo", ["maintenance", "run"], { ...options, waitForExit });
      await executeGitCommandBytes("/repo", ["maintenance", "run"], { ...options, waitForExit });
    }
    await executeGitCommandBuffered("/repo", ["maintenance", "run"], options);
  }
  const intents = (
    calls: ReadonlyArray<readonly [string[], (number | processExec.CommandOptions)?]>,
  ) =>
    calls.map(([, options]) => (typeof options === "object" ? options.executionIntent : undefined));
  expect(intents(text.mock.calls)).toEqual([
    "gateway-internal",
    "gateway-internal",
    "agent-tool",
    "agent-tool",
  ]);
  expect(intents(bytes.mock.calls)).toEqual([
    "gateway-internal",
    "gateway-internal",
    "agent-tool",
    "agent-tool",
  ]);
  expect(intents(buffered.mock.calls)).toEqual(["gateway-internal", "agent-tool"]);
});

describe("required Git output", () => {
  it.each(["cooperative", "uncertain"] as const)(
    "retains private native cancellation facts with %s cleanup",
    async (cleanup) => {
      const result = {
        ...createCommandResult({
          pid: 123,
          code: null,
          signal: null,
          termination: "signal",
          cleanup,
          killIssuedByAbort: true,
          outputLimitExceeded: false,
          stderr: "cancelled fixture",
        }),
        timeoutMs: 30_000,
      };
      const failure = await Promise.resolve()
        .then(() => requireGitCommandOutput("git remote", result))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "CommandExecutionError",
        message: "git remote failed (terminated):\ncancelled fixture",
      });
      expect(readCommandProcessFailure(failure)).toStrictEqual({
        pid: 123,
        code: null,
        termination: "signal",
        cleanup,
        killIssuedByAbort: true,
        outputLimitExceeded: false,
      });
    },
  );

  async function withGitBlob(
    input: string | Buffer,
    run: (root: string, args: string[]) => Promise<void>,
  ) {
    await withTestDir({ prefix: "openclaw-git-output-" }, async (root) => {
      await requireGitCommand(root, ["init"]);
      const oid = await requireGitCommand(root, ["hash-object", "-w", "--stdin"], { input });
      await run(root, ["cat-file", "blob", oid]);
    });
  }

  it("keeps raw text byte-for-byte and preserves the trimmed text contract", async () => {
    const stdout = " \u001b[31mname\u001b[0m\rredraw\0\r\n ";
    await withGitBlob(stdout, async (root, args) => {
      expect(
        requireGitCommandOutput("git cat-file blob", await executeGitCommand(root, args)),
      ).toBe(stdout);
      await expect(requireGitCommand(root, args)).resolves.toBe(stdout.trim());
    });
  });

  it("rejects incomplete buffered output from a real Git blob", async () => {
    const blob = Buffer.alloc(17 * 1024 * 1024, "x");
    await withGitBlob(blob, async (root, args) => {
      await expect(requireGitBuffer(root, args)).rejects.toThrow("output limit exceeded");
    });
  });
});

it("returns the Git-openable null path for the execution host", () => {
  mockProcessPlatform("win32");
  expect(gitNullConfigPath()).toBe("NUL");
  mockProcessPlatform("linux");
  expect(gitNullConfigPath()).toBe("/dev/null");
});
