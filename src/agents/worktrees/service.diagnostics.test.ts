import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { isMainThread, threadId } from "node:worker_threads";
import { Logger } from "tslog";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  areDiagnosticsEnabledForProcess,
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import * as commandExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { killPidIfAlive, waitForPidFile } from "../../test-utils/process-tree.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
const emptyFailure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 73,
  signal: null,
  killed: false,
  termination: "exit",
};

async function failureMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected worktree operation to fail");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

function gitCommandArgs(argv: readonly string[]): readonly string[] {
  if (argv[0] !== "git") {
    return [];
  }
  let command = 1;
  while (argv[command] === "-c" || argv[command] === "-C") {
    command += 2;
  }
  return argv.slice(command);
}

const terminationCases: Array<{
  name: string;
  result: Partial<SpawnResult>;
  expected: RegExp[];
}> = [
  {
    name: "exit without output",
    result: { code: 23 },
    expected: [/(?:exit|code|status)[^\n]*23/i],
  },
  {
    name: "exit with output",
    result: { code: 23, stderr: "fatal: dependency unavailable" },
    expected: [/fatal: dependency unavailable/, /(?:exit|code|status)[^\n]*23/i],
  },
  {
    name: "timeout with output",
    result: {
      code: 124,
      termination: "timeout",
      signal: "SIGTERM",
      killed: true,
      stderr: "waiting for dependency",
    },
    expected: [/waiting for dependency/, /timed?\s*out|timeout/i, /SIGTERM/],
  },
  {
    name: "timeout without output",
    result: {
      code: 124,
      termination: "timeout",
      signal: "SIGKILL",
      killed: true,
    },
    expected: [/timed?\s*out|timeout/i, /SIGKILL/],
  },
  {
    name: "signal without output",
    result: { code: null, termination: "signal", signal: "SIGTERM" },
    expected: [/SIGTERM/],
  },
];

describe("ManagedWorktreeService failure diagnostics", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-errors-"));
    repo = await initializeRepository(root);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeFailingSetup(): Promise<string> {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, "#!/bin/sh\nprintf 'fatal: setup failed\\n' >&2\nexit 9\n", {
      mode: 0o755,
    });
    return script;
  }

  it("reports actual mixed setup output without losing diagnostics or cleanup", async () => {
    const script = await writeFailingSetup();
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$OPENCLAW_WORKTREE_PATH" > "$OPENCLAW_SOURCE_TREE_PATH/setup-path.txt"',
        "printf '%s\\n' 'fatal: create local-fixture-input.txt and retry'",
        "printf '%s\\n' 'warning: optional fixture hint is unset' >&2",
        "exit 23",
        "",
      ].join("\n"),
    );
    const message = await failureMessage(
      service.create({ repoRoot: repo, name: "actual-failed-setup", baseRef: "HEAD" }),
    );
    const allocated = (await fs.readFile(path.join(repo, "setup-path.txt"), "utf8")).trim();
    await expect(fs.stat(allocated)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("actual-failed-setup");
    expect(await git(repo, "branch", "--list", "openclaw/actual-failed-setup")).toBe("");
    expect(service.listRegistryRecords()).toEqual([]);
    expect(message).toContain("worktree setup failed (exit code 23)");
    expect(message).toContain("create local-fixture-input.txt and retry");
    expect(message).toContain("optional fixture hint is unset");
    expect(message.length).toBeLessThanOrEqual(2_300);
  });

  it.each(terminationCases)("reports setup $name and removes its allocation", async (entry) => {
    const script = await writeFailingSetup();
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === script) {
        return { ...emptyFailure, ...entry.result };
      }
      return await realRunCommand(argv, options);
    });

    const message = await failureMessage(
      service.create({ repoRoot: repo, name: "terminated-setup", baseRef: "HEAD" }),
    );

    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("terminated-setup");
    expect(await git(repo, "branch", "--list", "openclaw/terminated-setup")).toBe("");
    expect(service.listRegistryRecords()).toEqual([]);
    expect(message).toContain("worktree setup failed");
    for (const pattern of entry.expected) {
      expect.soft(message).toMatch(pattern);
    }
    expect(message.length).toBeLessThanOrEqual(2_300);
  });

  it.each([
    { phase: "create", failedOperation: "remove" },
    { phase: "create", failedOperation: "branch" },
    { phase: "create", failedOperation: "both" },
    { phase: "restore", failedOperation: "remove" },
    { phase: "restore", failedOperation: "branch" },
    { phase: "restore", failedOperation: "both" },
  ] as const)(
    "reports the failed $failedOperation operation during $phase cleanup",
    async ({ phase, failedOperation }) => {
      const removeFails = failedOperation !== "branch";
      const branchFails = failedOperation !== "remove";
      const name = "cleanup-failure";
      const branch = `openclaw/${name}`;
      let record;
      if (phase === "restore") {
        record = await service.create({ repoRoot: repo, name, baseRef: "HEAD" });
        await service.remove({ id: record.id, reason: "test" });
      } else {
        await writeFailingSetup();
      }
      const registryBefore = service.listRegistryRecords();
      const fatal = "fatal: branch deletion denied";
      let cleanupPath: string | undefined;
      let restoreFailed = false;
      let removalFailed = false;
      let branchDeletionFailed = false;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const args = gitCommandArgs(argv);
        if (phase === "restore" && args[0] === "reset") {
          restoreFailed = true;
          return { ...emptyFailure, code: 45, stderr: "fatal: restore index failed" };
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          cleanupPath = args.at(-1);
          const removed = await realRunCommand(argv, options);
          expect(removed.code).toBe(0);
          // A child can fail after applying its filesystem effects. Later branch
          // deletion output must not mask this removal failure.
          removalFailed = removeFails;
          return removeFails ? emptyFailure : { ...removed, stdout: "worktree removal complete" };
        }
        if (args[0] === "branch" && args[1] === "-D" && branchFails) {
          branchDeletionFailed = true;
          return {
            ...emptyFailure,
            stderr: `${"Deleting branch\r".repeat(200)}\n${"x".repeat(8_000)}${fatal}`,
          };
        }
        return await realRunCommand(argv, options);
      });

      const message = await failureMessage(
        record
          ? service.restore({ id: record.id })
          : service.create({ repoRoot: repo, name, baseRef: "HEAD" }),
      );

      expect(restoreFailed).toBe(phase === "restore");
      expect(removalFailed).toBe(removeFails);
      expect(branchDeletionFailed).toBe(branchFails);
      expect(cleanupPath).toBeDefined();
      await expect(fs.stat(cleanupPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(service.listRegistryRecords()).toEqual(registryBefore);
      expect(await git(repo, "branch", "--list", branch)).toBe(branchFails ? branch : "");
      if (record) {
        expect(await git(repo, "show-ref", "--verify", registryBefore[0]!.snapshotRef!)).not.toBe(
          "",
        );
      }
      expect(message).toContain(
        phase === "restore" ? "fatal: restore index failed" : "fatal: setup failed",
      );
      const label =
        phase === "restore" ? "restore cleanup failed:" : "failed to clean up worktree creation:";
      expect(message).toContain(label);
      const cleanupMessage = message.slice(message.indexOf(label) + label.length);
      expect.soft(cleanupMessage).toContain(removeFails ? "git worktree remove" : "git branch -D");
      expect.soft(/(?:exit|code|status)[^\n]*73/i.test(cleanupMessage)).toBe(true);
      expect.soft(cleanupMessage).not.toContain("worktree removal complete");
      expect.soft(cleanupMessage).not.toContain("Deleted branch");
      if (!removeFails) {
        expect.soft(cleanupMessage.includes(fatal)).toBe(true);
      } else {
        expect.soft(cleanupMessage).not.toContain(fatal);
      }
      expect.soft(cleanupMessage.length).toBeLessThanOrEqual(2_300);
    },
  );

  it("lets admitted deletion settle after cancellation and keeps its complete recovery snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "cancel-removal",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "complete recoverable edit\n");
    const marker = path.join(root, "removal-child.pid");
    const release = path.join(root, "release-removal");
    let removalStarted = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const args = gitCommandArgs(argv);
      if (args[0] === "worktree" && args[1] === "remove") {
        removalStarted = true;
        // A real held child models Git after it has removed the first tracked file.
        const partial = await realRunCommand(
          [
            process.execPath,
            "-e",
            'const fs = require("node:fs"); fs.unlinkSync(process.argv[1]); fs.writeFileSync(process.argv[2], String(process.pid)); const timer = setInterval(() => { if (fs.existsSync(process.argv[3])) clearInterval(timer); }, 10);',
            path.join(created.path, "README.md"),
            marker,
            release,
          ],
          options,
        );
        if (partial.code !== 0) {
          return partial;
        }
      }
      return await realRunCommand(argv, options);
    });
    const abort = new AbortController();
    const pending = service.remove({ id: created.id, reason: "test", signal: abort.signal }).then(
      () => false,
      () => true,
    );
    let pid: number | undefined;
    try {
      pid = await waitForPidFile(marker);
      expect(removalStarted).toBe(true);
      expect(isPidAlive(pid)).toBe(true);
      const snapshotRef = service
        .listRegistryRecords()
        .find((record) => record.id === created.id)?.snapshotRef;
      expect(snapshotRef).toBeDefined();
      const snapshot = await git(repo, "rev-parse", snapshotRef!);
      abort.abort(new Error("fixture cancellation during deletion"));
      await fs.writeFile(release, "release");
      expect(await pending).toBe(true);
      expect(isPidAlive(pid)).toBe(false);
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(repo, "rev-parse", snapshotRef!)).toBe(snapshot);
      expect(await git(repo, "show", `${snapshotRef}:README.md`)).toBe("complete recoverable edit");
    } finally {
      abort.abort();
      await fs.writeFile(release, "release");
      killPidIfAlive(pid);
      await pending;
    }
  });

  it.each([
    { name: "long evidence inside the existing window", oldEvidenceVisible: true },
    { name: "evidence outside the existing newline window", oldEvidenceVisible: false },
  ])("preserves retry authority for $name", async ({ oldEvidenceVisible }) => {
    await git(path.join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main");
    await git(repo, "remote", "set-head", "origin", "-a");
    const name = "retry-evidence";
    const branch = `openclaw/${name}`;
    let allocatedPath: string | undefined;
    let checkoutFailed = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRunCommand(argv, options);
      const args = gitCommandArgs(argv);
      if (!checkoutFailed && args[0] === "worktree" && args[1] === "add") {
        checkoutFailed = true;
        allocatedPath = args.at(-2);
        expect(result.code).toBe(0);
        const separator = oldEvidenceVisible ? "\r" : "\n";
        return {
          ...result,
          code: 1,
          stderr: `Preparing worktree (new branch '${branch}')${separator}${`progress ${"x".repeat(200)}${separator}`.repeat(20)}fatal: checkout failed`,
        };
      }
      return result;
    });

    if (oldEvidenceVisible) {
      const created = await service.create({ repoRoot: repo, name });
      expect(checkoutFailed).toBe(true);
      expect(created.baseRef).toBe("HEAD");
      expect(await git(created.path, "branch", "--show-current")).toBe(branch);
      expect(service.listRegistryRecords()).toEqual([created]);
    } else {
      await expect(service.create({ repoRoot: repo, name })).rejects.toThrow("checkout failed");
      expect(checkoutFailed).toBe(true);
      expect(service.listRegistryRecords()).toEqual([]);
    }
    expect(allocatedPath).toBeDefined();
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(allocatedPath);
    expect(await git(allocatedPath!, "branch", "--show-current")).toBe(branch);
  });
});

describe("ManagedWorktreeService removal timing", { concurrent: false }, () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const trace = {
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
    parentSpanId: "abcdef1234567890",
    traceFlags: "01",
  };
  const leaseContext: stateLease.OpenClawStateLeaseContext = {
    signal: new AbortController().signal,
    assertOwned: () => {},
    assertOwnedInTransaction: () => {},
  };
  const identityFields = {
    subsystem: "agents/worktrees",
    pid: process.pid,
    threadId,
    isMainThread,
  };
  let clock = 120_000;
  let clockSpy: MockInstance<() => number>;
  let root: string;
  let logFile: string;
  let service: ManagedWorktreeService;
  let diagnosticsWereEnabled: boolean;
  let unsubscribe: () => void;
  let records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>>;

  beforeEach(() => {
    root = tempDirs.make("openclaw-removal-timing-");
    logFile = path.join(root, "runtime.log");
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "private-state") },
    });
    diagnosticsWereEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    resetLogger();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
    clock += 120_000;
    clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    records = [];
    unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "log.record" && event.message === "slow managed worktree removal") {
          records.push(event);
        }
      },
      { include: ["log.record"] },
    );
  });

  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    unsubscribe();
    await flushLogger();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    setLoggerOverride(null);
    resetLogger();
  });

  it.each([false, true])(
    "attributes admission, body and finalization without completing early (logger fails=%s)",
    async (loggerFails) => {
      const repo = await initializeRepository(root);
      const stateDir = path.join(root, "private-state");
      const worktree = await materializeManagedWorktreeFixture({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        repoRoot: repo,
        name: "private-removal",
        now: Date.now(),
      });
      const admissionEntered = createDeferredCore();
      const releaseAdmission = createDeferredCore();
      const bodyEntered = createDeferredCore();
      const releaseBody = createDeferredCore();
      const finalizeEntered = createDeferredCore();
      const releaseFinalize = createDeferredCore();
      let callbackResult: unknown;
      vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async (_options, run) => {
        admissionEntered.resolve();
        await releaseAdmission.promise;
        const result = await run(leaseContext);
        callbackResult = result;
        finalizeEntered.resolve();
        await releaseFinalize.promise;
        return result;
      });
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementationOnce(async (...args) => {
        bodyEntered.resolve();
        await releaseBody.promise;
        return await realRunCommand(...args);
      });
      let completed = false;
      const pending = runWithDiagnosticTraceContext(trace, () =>
        service.remove({ id: worktree.id, reason: "private-removal-reason" }),
      ).then((result) => {
        completed = true;
        return result;
      });
      try {
        await Promise.race([admissionEntered.promise, pending]);
        clock += 1_100;
        releaseAdmission.resolve();
        await Promise.race([bodyEntered.promise, pending]);
        clock += 200;
        releaseBody.resolve();
        await Promise.race([finalizeEntered.promise, pending]);
        await waitForDiagnosticEventsDrained();
        expect(completed).toBe(false);
        expect(records).toEqual([]);
        const failedLogger = loggerFails
          ? vi.spyOn(Logger.prototype, "info").mockImplementation(() => {
              throw new Error("diagnostic logger unavailable");
            })
          : undefined;
        clock += 300;
        releaseFinalize.resolve();
        const result = await pending;
        expect(result).toBe(callbackResult);
        expect(result.removed).toBe(true);
        await waitForDiagnosticEventsDrained();
        if (failedLogger) {
          expect(failedLogger).toHaveBeenCalled();
        } else {
          expect(records).toHaveLength(1);
          expect(records[0]?.trace).toEqual(trace);
          expect(records[0]?.attributes).toEqual({
            ...identityFields,
            durationMs: 1_600,
            admissionMs: 1_100,
            bodyMs: 200,
            finalizeMs: 300,
            callbackEntered: true,
            outcome: "returned",
            omittedObservations: expect.any(Number),
          });
        }
      } finally {
        releaseAdmission.resolve();
        releaseBody.resolve();
        releaseFinalize.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("reports only reached phases at the slow threshold without retaining private input or inventing a trace", async () => {
    const operationError = new Error("private repository /private/source failed for private-owner");
    const failBeforeEntry = async (duration: number) => {
      vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementationOnce(async () => {
        clock += duration;
        throw operationError;
      });
      await expect(
        service.remove({ id: "private-worktree-id", reason: "private-removal-reason" }),
      ).rejects.toBe(operationError);
      await waitForDiagnosticEventsDrained();
    };
    await runWithDiagnosticTraceContext(undefined, async () => {
      await failBeforeEntry(999);
      expect(records).toEqual([]);
      await failBeforeEntry(1_000);
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.trace).toBeUndefined();
    expect(records[0]?.attributes).toEqual({
      ...identityFields,
      durationMs: 1_000,
      admissionMs: 1_000,
      callbackEntered: false,
      outcome: "threw",
      omittedObservations: expect.any(Number),
    });
  });

  it.each([false, true])(
    "preserves body errors through finalization (logger fails=%s)",
    async (loggerFails) => {
      const operationError = new Error("private owner authority expired");
      vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async (_options, run) => {
        clock += 400;
        try {
          return await run(leaseContext);
        } finally {
          clock += 250;
        }
      });
      const failedLogger = loggerFails
        ? vi.spyOn(Logger.prototype, "info").mockImplementation(() => {
            throw new Error("diagnostic logger unavailable");
          })
        : undefined;
      await expect(
        service.remove({
          id: "private-worktree-id",
          reason: "private-removal-reason",
          commitGuard: () => {
            clock += 350;
            throw operationError;
          },
        }),
      ).rejects.toBe(operationError);
      await waitForDiagnosticEventsDrained();
      if (failedLogger) {
        expect(failedLogger).toHaveBeenCalled();
      } else {
        expect(records).toHaveLength(1);
        expect(records[0]?.attributes).toMatchObject({
          durationMs: 1_000,
          admissionMs: 400,
          bodyMs: 350,
          finalizeMs: 250,
          callbackEntered: true,
          outcome: "threw",
        });
      }
    },
  );

  it.each(["diagnostics", "info logger"] as const)(
    "checks %s at entry and settlement without timing a disabled call",
    async (gate) => {
      const setGate = (enabled: boolean) => {
        if (gate === "diagnostics") {
          setDiagnosticsEnabledForProcess(enabled);
        } else {
          setLoggerOverride({
            level: enabled ? "info" : "warn",
            consoleLevel: "silent",
            file: logFile,
          });
        }
      };
      const operationError = new Error("lease acquisition failed");
      setGate(false);
      vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementationOnce(async () => {
        setGate(true);
        clock += 1_000;
        throw operationError;
      });
      await expect(service.remove({ id: "private-id", reason: "test" })).rejects.toBe(
        operationError,
      );
      expect(clockSpy).not.toHaveBeenCalled();
      vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementationOnce(async () => {
        setGate(false);
        clock += 1_000;
        throw operationError;
      });
      await expect(service.remove({ id: "private-id", reason: "test" })).rejects.toBe(
        operationError,
      );
      await waitForDiagnosticEventsDrained();
      expect(records).toEqual([]);
    },
  );

  it("bounds simultaneous slow removals and carries omitted observations into the next window", async () => {
    const operationError = new Error("lease unavailable");
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async () => {
      clock += 1_000;
      throw operationError;
    });
    // Drain any omissions left by an earlier logger-failure case without resetting private state.
    await expect(service.remove({ id: "private-id", reason: "test" })).rejects.toBe(operationError);
    await waitForDiagnosticEventsDrained();
    records.length = 0;
    clock += 60_000;
    const release = createDeferredCore();
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async () => {
      await release.promise;
      throw operationError;
    });
    const pending = Array.from({ length: 62 }, () =>
      service.remove({ id: "private-id", reason: "test" }).catch((error: unknown) => error),
    );
    clock += 1_000;
    release.resolve();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 62 }, () => operationError));
    await waitForDiagnosticEventsDrained();
    expect(records).toHaveLength(60);
    clock += 60_000;
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async () => {
      clock += 1_000;
      throw operationError;
    });
    await expect(service.remove({ id: "private-id", reason: "test" })).rejects.toBe(operationError);
    await waitForDiagnosticEventsDrained();
    expect(records).toHaveLength(61);
    expect(records.at(-1)?.attributes?.omittedObservations).toBe(2);
    await expect(service.remove({ id: "private-id", reason: "test" })).rejects.toBe(operationError);
    await waitForDiagnosticEventsDrained();
    expect(records.at(-1)?.attributes?.omittedObservations).toBe(0);
  });
});
