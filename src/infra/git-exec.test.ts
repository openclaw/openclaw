import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { requireGitBuffer } from "../agents/worktrees/git.js";
import * as execRunner from "../process/exec-runner.js";
import * as processExec from "../process/exec.js";
import type { SpawnResult } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
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
  let clockSpy: MockInstance<() => number>;
  const traces: Array<DiagnosticTraceContext | undefined> = [];
  const processMetadata = { pid: process.pid, threadId, isMainThread };

  beforeEach(() => {
    // Advance past the previous owner's window without resetting its live singleton.
    clockEpoch += 120_000;
    clock = clockEpoch;
    clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(diagnosticEvents, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    vi.spyOn(fs, "realpath").mockImplementation(async (filename) => String(filename));
    refLogs.isEnabled.mockReset().mockReturnValue(true);
    refLogs.info.mockReset().mockImplementation(() => {
      traces.push(getActiveDiagnosticTraceContext());
    });
    traces.length = 0;
  });

  it("attributes a held same-directory predecessor separately from resolution and callback work", async () => {
    const holderEntered = createDeferred();
    const releaseHolder = createDeferred();
    const callbackEntered = createDeferred();
    const releaseCallback = createDeferred();
    const resolved = createDeferred<string>();
    const trace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: "01",
    };
    const result = { privateResult: "refs/private/result" };
    vi.mocked(diagnosticEvents.areDiagnosticsEnabledForProcess).mockReturnValue(false);
    vi.mocked(fs.realpath).mockResolvedValueOnce("/private/shared.git");
    const holder = enqueueGitRefMutation("/private/holder", ".git", async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    const pending: Promise<unknown>[] = [holder];
    try {
      await holderEntered.promise;
      vi.mocked(diagnosticEvents.areDiagnosticsEnabledForProcess).mockReturnValue(true);
      vi.mocked(fs.realpath).mockImplementationOnce(() => resolved.promise);
      const callback = vi.fn(async () => {
        callbackEntered.resolve();
        await releaseCallback.promise;
        return result;
      });
      const queued = runWithDiagnosticTraceContext(trace, () =>
        enqueueGitRefMutation("/private/linked-checkout", "../shared.git", callback),
      );
      pending.push(queued);
      clock += 25;
      resolved.resolve("/private/shared.git");
      const independent = { independent: true };
      await expect(
        enqueueGitRefMutation("/private/other", ".git", async () => independent),
      ).resolves.toBe(independent);
      expect(callback).not.toHaveBeenCalled();
      expect(refLogs.info).not.toHaveBeenCalled();

      clock += 1_200;
      releaseHolder.resolve();
      await callbackEntered.promise;
      expect(refLogs.info).not.toHaveBeenCalled();
      clock += 175;
      releaseCallback.resolve();
      await expect(queued).resolves.toBe(result);
      expect(refLogs.info).toHaveBeenCalledExactlyOnceWith("slow Git ref mutation", {
        ...processMetadata,
        durationMs: 1_400,
        resolveMs: 25,
        queueWaitMs: 1_200,
        queuedOperationMs: 175,
        callbackEntered: true,
        outcome: "returned",
        omittedObservations: 0,
      });
      expect(traces).toEqual([trace]);
    } finally {
      resolved.resolve("/private/shared.git");
      releaseHolder.resolve();
      releaseCallback.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("reports only reached resolution time and preserves the original failure without inventing a trace", async () => {
    const error = new Error("cannot resolve /private/repository/refs/private");
    const callback = vi.fn();
    vi.mocked(fs.realpath).mockImplementationOnce(async () => {
      clock += 1_000;
      throw error;
    });
    await expect(
      runWithDiagnosticTraceContext(undefined, () =>
        enqueueGitRefMutation("/private/repository", "refs/private", callback),
      ),
    ).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(refLogs.info).toHaveBeenCalledExactlyOnceWith("slow Git ref mutation", {
      ...processMetadata,
      durationMs: 1_000,
      resolveMs: 1_000,
      callbackEntered: false,
      outcome: "threw",
      omittedObservations: 0,
    });
    expect(traces).toEqual([undefined]);
  });

  it.each(["sync", "async"] as const)(
    "preserves a %s callback error and reports no private error content",
    async (mode) => {
      const error = new Error("failed update-ref refs/private at /private/repository");
      const callback = () => {
        clock += 1_000;
        if (mode === "sync") {
          throw error;
        }
        return Promise.reject(error);
      };
      await expect(enqueueGitRefMutation("/private/repository", ".git", callback)).rejects.toBe(
        error,
      );
      expect(refLogs.info).toHaveBeenCalledExactlyOnceWith("slow Git ref mutation", {
        ...processMetadata,
        durationMs: 1_000,
        resolveMs: 0,
        queueWaitMs: 0,
        queuedOperationMs: 1_000,
        callbackEntered: true,
        outcome: "threw",
        omittedObservations: 0,
      });
      const next = { next: true };
      await expect(
        enqueueGitRefMutation("/private/repository", ".git", async () => next),
      ).resolves.toBe(next);
    },
  );

  it.each([
    { name: "diagnostics disabled at entry", gate: "diagnostics", atEntry: true },
    { name: "info disabled at entry", gate: "info", atEntry: true },
    { name: "diagnostics disabled at settlement", gate: "diagnostics", atEntry: false },
    { name: "info disabled at settlement", gate: "info", atEntry: false },
  ])("does not emit when $name", async ({ gate, atEntry }) => {
    const disable = () => {
      if (gate === "diagnostics") {
        vi.mocked(diagnosticEvents.areDiagnosticsEnabledForProcess).mockReturnValue(false);
      } else {
        refLogs.isEnabled.mockReturnValue(false);
      }
    };
    if (atEntry) {
      disable();
    }
    const result = { preserved: true };
    await expect(
      enqueueGitRefMutation("/private/repository", ".git", async () => {
        clock += 1_000;
        disable();
        return result;
      }),
    ).resolves.toBe(result);
    expect(refLogs.info).not.toHaveBeenCalled();
    if (atEntry) {
      expect(clockSpy).not.toHaveBeenCalled();
    }
  });

  it("keeps operations below the raw one-second threshold silent", async () => {
    await enqueueGitRefMutation("/private/repository", ".git", async () => {
      clock += 999.75;
    });
    expect(refLogs.info).not.toHaveBeenCalled();
  });

  it.each(["returned", "threw"] as const)(
    "preserves the %s outcome when the diagnostic sink throws",
    async (outcome) => {
      const original = new Error("original outcome");
      refLogs.info.mockImplementation(() => {
        throw new Error("diagnostic sink failed");
      });
      const operation = enqueueGitRefMutation("/private/repository", ".git", async () => {
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
      await enqueueGitRefMutation("/private/next-window", ".git", async () => {
        clock += 1_000;
      });
      expect(refLogs.info).toHaveBeenCalledTimes(61);
      expect(refLogs.info.mock.lastCall?.[1]).toMatchObject({ omittedObservations: 4 });
      await enqueueGitRefMutation("/private/next-window", ".git", async () => {
        clock += 1_000;
      });
      expect(refLogs.info).toHaveBeenCalledTimes(62);
      expect(refLogs.info.mock.lastCall?.[1]).toMatchObject({ omittedObservations: 0 });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });
});

describe("Git filesystem paths", () => {
  it.each([
    { input: "/c", expected: "C:\\" },
    { input: "/C", expected: "C:\\" },
    { input: "/c/", expected: "C:\\" },
    { input: "/c/Users/example/repo", expected: "C:\\Users\\example\\repo" },
    { input: "C:\\c\\Users\\example", expected: "C:\\c\\Users\\example" },
    { input: "C:/Users/example", expected: "C:/Users/example" },
    { input: "\\\\server\\share\\repo", expected: "\\\\server\\share\\repo" },
    { input: "relative/repo", expected: "relative/repo" },
    { input: "/cygdrive/c/repo", expected: "/cygdrive/c/repo" },
    { input: "/workspace/repo", expected: "/workspace/repo" },
    { input: "/rr", expected: "/rr" },
  ])("normalizes only standard MSYS drive paths on Windows: $input", ({ input, expected }) => {
    expect(normalizeGitPathForFilesystem(input, "win32")).toBe(expected);
  });

  it.each(["/c", "/C", "/c/", "/c/Users/example/repo"])(
    "leaves MSYS-shaped text unchanged on non-Windows hosts: %s",
    (input) => {
      expect(normalizeGitPathForFilesystem(input, "linux")).toBe(input);
    },
  );
});

const progress = Array.from({ length: 1000 }, (_, i) => `Updating files: ${i}/1000`).join("\r");
const failure = {
  stdout: "",
  stderr: "",
  code: 128,
  signal: null,
  killed: false,
  termination: "exit",
} satisfies SpawnResult;

it.each(["maintenance.autoDetach", "gc.autoDetach"])(
  "overrides %s only for an explicitly owned Git command",
  async (key) => {
    await withTestDir({ prefix: "openclaw-git-exec-maintenance-" }, async (root) => {
      await requireGitCommand(root, ["init"]);
      await requireGitCommand(root, ["config", key, "true"]);
      const owned = await executeGitCommand(root, ["config", "--get", key], {
        killProcessTree: true,
      });
      expect(owned.code).toBe(0);
      expect(owned.stdout.trim()).toBe("false");
      await expect(requireGitCommand(root, ["config", "--get", key])).resolves.toBe("true");
    });
  },
);

it.each([
  { timeoutMs: undefined, seconds: 120 },
  { timeoutMs: 300_000, seconds: 300 },
])("reports the applied $seconds-second Git timeout", async ({ timeoutMs, seconds }) => {
  const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
    ...failure,
    termination: "timeout",
    code: 124,
  });
  const args = ["worktree", "add"];
  const result = await executeGitCommand("/repo", args, { timeoutMs });
  const label = `timed out after ${seconds} seconds`;
  const message = createGitCommandError("git worktree add", result).message;
  expect(message).toContain(label);
  expect(message).toContain(
    `Git did not finish within its ${seconds}s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).`,
  );
  await expect(requireGitCommand("/repo", args, { timeoutMs })).rejects.toThrow(label);
  expect(
    commandSpy.mock.calls.map(([, options]) =>
      typeof options === "number" ? options : options.timeoutMs,
    ),
  ).toEqual([seconds * 1000, seconds * 1000]);
});

describe.each([
  ["text", requireGitCommand],
  ["buffered", requireGitBuffer],
] as const)("Git %s diagnostics", (_kind, requireGit) => {
  async function failureMessage(args: string[]): Promise<string> {
    try {
      await requireGit("/repo", args);
    } catch (error) {
      if (error instanceof Error) {
        return error.message;
      }
      throw error;
    }
    throw new Error("Expected Git to fail");
  }

  function failWith(overrides: Partial<SpawnResult>) {
    const result = { ...failure, ...overrides };
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce(result);
    vi.spyOn(processExec, "runCommandBuffered").mockResolvedValueOnce({
      ...result,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      code: result.termination === "exit" && !result.outputLimitExceeded ? result.code : null,
      termination: result.outputLimitExceeded
        ? "output-limit"
        : result.termination === "no-output-timeout"
          ? "timeout"
          : result.termination,
    });
  }

  it.each(["\n", "\r\n"])(
    "collapses redraws and preserves fatal details with %j",
    async (newline) => {
      failWith({
        stderr: `Preparing worktree${newline}${progress}\r${newline}\u001b[31mfatal: disk full\u001b[0m${newline}`,
      });
      await expect(requireGit("/repo", ["worktree", "add"])).rejects.toThrow(
        "git worktree add failed (exit code 128):\nPreparing worktree\nUpdating files: 999/1000\nfatal: disk full",
      );
    },
  );

  it("bounds long diagnostic lines and keeps the useful tail", async () => {
    failWith({ stderr: `${"x".repeat(30_000)}\nfatal: permission denied\n` });
    const message = await failureMessage(["status"]);
    expect(message.length).toBeLessThanOrEqual(2400);
    expect(message).toContain("…");
    expect(message).toMatch(/fatal: permission denied$/);
  });

  it("bounds newline progress and reports exit 124 without inventing a timeout", async () => {
    failWith({ code: 124, stderr: progress.replaceAll("\r", "\n") });
    const message = await failureMessage(["status"]);
    expect(message.length).toBeLessThanOrEqual(2400);
    expect(message.split("\n").length).toBeLessThanOrEqual(14);
    expect(message).toContain("exit code 124");
    expect(message).not.toMatch(/timed out|timeout/i);
  });

  it.each([
    {
      termination: "exit",
      code: 128,
      stdoutTruncatedBytes: 1,
      expected: "exit code 128",
    },
    {
      termination: "timeout",
      signal: "SIGKILL",
      code: 124,
      expected: "timed out after 120 seconds; signal SIGKILL",
    },
    {
      termination: "signal",
      signal: "SIGTERM",
      code: null,
      expected: "signal SIGTERM",
    },
    {
      termination: "signal",
      signal: null,
      code: 0,
      killed: false,
      expected: "terminated",
    },
    {
      termination: "signal",
      signal: "SIGKILL",
      outputLimitExceeded: true,
      code: null,
      expected: "output limit exceeded; signal SIGKILL",
    },
  ] satisfies Array<Partial<SpawnResult> & { expected: string }>)(
    "reports $expected even when only progress was captured",
    async ({ expected, ...metadata }) => {
      failWith({ ...metadata, stderr: progress });
      const message = await failureMessage(["worktree", "add"]);
      expect(message).toContain(`failed (${expected})`);
      expect(message.length).toBeLessThan(400);
      expect(message).toContain("Updating files: 999/1000");
      if (metadata.termination === "timeout") {
        expect(message).toContain(
          "Git did not finish within its 120s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).",
        );
      } else {
        expect(message).not.toMatch(/timed out|timeout/i);
      }
    },
  );

  it.each(["", " \t\r\n", `${String.fromCharCode(27)}[0m`, "progress\r \t"])(
    "uses stdout when stderr has no visible diagnostic: %j",
    async (stderr) => {
      failWith({ stderr, stdout: "error: cannot read index\n" });
      await expect(requireGit("/repo", ["status"])).rejects.toThrow("error: cannot read index");
    },
  );
});

describe("required Git output", () => {
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

  it("rejects buffered I/O failures after a zero exit", async () => {
    const error = Object.assign(new Error("stdout read failed"), {
      exitCode: 0,
      outputErrorStream: "stdout",
    });
    vi.spyOn(execRunner, "runCommandWithTimeout").mockRejectedValueOnce(error);
    await expect(requireGitBuffer("/repo", ["cat-file", "blob", "HEAD:file"])).rejects.toThrow(
      "git cat-file blob HEAD:file failed",
    );
  });

  it("keeps binary output including invalid UTF-8 and terminal control bytes", async () => {
    const stdout = Buffer.from([0, 255, 13, 10, 27, 91, 51, 49, 109, 32]);
    await withGitBlob(stdout, async (root, args) => {
      await expect(requireGitBuffer(root, args)).resolves.toEqual(stdout);
    });
  });

  it.each([
    ["text", requireGitCommand],
    ["buffered", requireGitBuffer],
  ] as const)("rejects incomplete %s output from a real Git blob", async (_kind, requireGit) => {
    const sentinel = "complete-git-output-leading-sentinel\0";
    const blob = Buffer.alloc(17 * 1024 * 1024, "x");
    blob.write(sentinel);
    await withGitBlob(blob, async (root, args) => {
      const outcome = await requireGit(root, args).then(
        (stdout) => ({
          kind: "returned",
          bytes: Buffer.byteLength(stdout),
          hasSentinel: stdout.includes(sentinel),
        }),
        (error: unknown) => ({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      expect(outcome).toEqual({
        kind: "error",
        message: expect.stringContaining("output limit exceeded"),
      });
    });
  });

  it("accepts complete text when only diagnostic stderr was truncated", async () => {
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
      ...failure,
      code: 0,
      stdout: "complete\n",
      stderr: "progress tail",
      stderrTruncatedBytes: 1,
    });
    expect(
      requireGitCommandOutput("git status", await executeGitCommand("/repo", ["status"])),
    ).toBe("complete\n");
    await expect(requireGitCommand("/repo", ["status"])).resolves.toBe("complete");
  });
});

describe("gitNullConfigPath", () => {
  it("returns the Git-openable null path for the execution host", () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // Git for Windows cannot open the device-namespace path that
      // os.devNull returns; "NUL" is the path it understands.
      expect(gitNullConfigPath()).toBe("NUL");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(gitNullConfigPath()).toBe("/dev/null");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("is accepted by the real git binary as GIT_CONFIG_GLOBAL on this host", () => {
    const repo = fsSync.mkdtempSync(path.join(os.tmpdir(), "git-null-config-"));
    try {
      fsSync.writeFileSync(path.join(repo, "file.txt"), "x");
      const baseEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      };
      const init = spawnSync("git", ["init", "-q", repo], { env: baseEnv, encoding: "utf8" });
      expect(init.status).toBe(0);
      const log = spawnSync("git", ["-C", repo, "log", "--oneline", "-1"], {
        env: baseEnv,
        encoding: "utf8",
      });
      // Empty repo: git may exit non-zero for "no commits", but config parsing
      // must not fail with the device-namespace access error (exit 128).
      expect(log.stderr).not.toContain("unable to access");
    } finally {
      fsSync.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "documents the defect: os.devNull as GIT_CONFIG_GLOBAL exits 128 on Windows",
    () => {
      const repo = fsSync.mkdtempSync(path.join(os.tmpdir(), "git-null-config-"));
      try {
        const result = spawnSync("git", ["-C", repo, "log", "--oneline", "-1"], {
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "0",
            GIT_CONFIG_GLOBAL: os.devNull,
          },
          encoding: "utf8",
        });
        // Red evidence for issue #141279: the device-namespace path that
        // os.devNull returns is rejected by Git for Windows.
        expect(result.stderr).toContain("unable to access");
      } finally {
        fsSync.rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
