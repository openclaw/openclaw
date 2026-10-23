import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import * as gitWorker from "../../infra/git-worker.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import * as commandExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import * as worktreeRunLease from "./run-lease.js";
import { ManagedWorktreeService, WorktreeSnapshotError } from "./service.js";
import {
  git,
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const realRunCommand = commandExec.runCommandWithTimeout;
const realRunGitWorkerOperation = gitWorker.runGitWorkerOperation;
const realAbortWorktreeRemoval = worktreeRunLease.abortWorktreeRemoval;
const emptyFailure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 73,
  signal: null,
  killed: false,
  termination: "exit",
};

async function failureMessage(operation: Promise<unknown>): Promise<string> {
  const failure: unknown = await operation.then(
    () => assert.fail("expected worktree operation to fail"),
    (cause: unknown) => cause,
  );
  assert(failure instanceof Error);
  return failure.message;
}

const expectAbsent = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const readme = (directory: string) => path.join(directory, "README.md");

function gitCommandArgs(argv: readonly string[]): readonly string[] {
  let command = argv[0] === "nice" ? 3 : 0;
  if (argv[command] !== "git") {
    return [];
  }
  command++;
  while (argv[command] === "-c" || argv[command] === "-C") {
    command += 2;
  }
  return argv.slice(command);
}

describe("ManagedWorktreeService diagnostics", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;
  const create = (name: string) => service.create({ repoRoot: repo, name, baseRef: "HEAD" });
  const findRecord = async (id: string) =>
    (await service.listRegistryRecords()).find((record) => record.id === id);

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-errors-");
    repo = await initializeRepository(root);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      // Inject failures into the requested checkout rather than a source template.
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  it.each(["create", "restore"] as const)("reports %s cleanup failures", async (phase) => {
    const removeFails = phase === "restore";
    const name = "cleanup-failure";
    const branch = `openclaw/${name}`;
    let record;
    if (phase === "restore") {
      record = await create(name);
      await service.remove({ id: record.id, reason: "test" });
    } else {
      const script = path.join(repo, ".openclaw", "worktree-setup.sh");
      await fs.mkdir(path.dirname(script));
      await fs.writeFile(script, "#!/bin/sh\nprintf 'fatal: setup failed\\n' >&2\nexit 9\n", {
        mode: 0o755,
      });
    }
    const registryBefore = await service.listRegistryRecords();
    const fatal = "fatal: branch deletion denied";
    let cleanupPath: string | undefined;
    let branchDeletionFailed = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const args = gitCommandArgs(argv);
      if (phase === "restore" && args[0] === "reset") {
        return { ...emptyFailure, code: 45, stderr: "fatal: restore index failed" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        cleanupPath = args.at(-1);
        const removed = await realRunCommand(argv, options);
        expect(removed.code).toBe(0);
        // A child can fail after applying its filesystem effects. Later branch
        // deletion output must not mask this removal failure.
        return removeFails ? emptyFailure : { ...removed, stdout: "worktree removal complete" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        branchDeletionFailed = true;
        return {
          ...emptyFailure,
          stderr: `${"Deleting branch\r".repeat(200)}\n${"x".repeat(8_000)}${fatal}`,
        };
      }
      return await realRunCommand(argv, options);
    });

    const message = await failureMessage(
      record ? service.restore({ id: record.id }) : create(name),
    );

    expect(branchDeletionFailed).toBe(true);
    expect(cleanupPath).toBeDefined();
    await expectAbsent(cleanupPath!);
    expect(await service.listRegistryRecords()).toEqual(registryBefore);
    expect(await git(repo, "branch", "--list", branch)).toBe(branch);
    if (record) {
      expect(await git(repo, "show-ref", "--verify", registryBefore[0]!.snapshotRef!)).not.toBe("");
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
    expect.soft(cleanupMessage).not.toMatch(/worktree removal complete|Deleted branch/);
    expect.soft(cleanupMessage.includes(fatal)).toBe(!removeFails);
    expect.soft(cleanupMessage.length).toBeLessThanOrEqual(2_300);
  });

  it("lets admitted deletion settle after cancellation and keeps its complete recovery snapshot", async () => {
    const created = await create("cancel-removal");
    const contents = "complete recoverable edit\n";
    await fs.writeFile(readme(created.path), contents);
    const childReady = createDeferredCore<number>();
    let readinessOutput = "";
    const release = path.join(root, "release-removal");
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const args = gitCommandArgs(argv);
      if (args[0] === "worktree" && args[1] === "remove") {
        // Hold Git unregistration after the checkout's files have been renamed away.
        const partial = await realRunCommand(
          [
            process.execPath,
            "-e",
            'const fs = require("node:fs"); process.stdout.write(String(process.pid) + "\\n"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 10);',
            release,
          ],
          {
            ...(typeof options === "number" ? { timeoutMs: options } : options),
            onOutputChunk: (chunk, stream) => {
              if (stream === "stdout") {
                readinessOutput += chunk.toString("utf8");
                if (readinessOutput.endsWith("\n")) {
                  childReady.resolve(Number(readinessOutput.trim()));
                }
              }
            },
          },
        );
        if (partial.code !== 0) {
          return partial;
        }
      }
      return await realRunCommand(argv, options);
    });
    const abort = new AbortController();
    const pending = failureMessage(
      service.remove({ id: created.id, reason: "test", signal: abort.signal }),
    );
    let pid: number | undefined;
    try {
      // Snapshot preparation and child startup share no fixed readiness deadline.
      pid = await Promise.race([
        childReady.promise,
        pending.then((message) => {
          throw new Error(`Removal settled before child readiness: ${message}`);
        }),
      ]);
      expect(isPidAlive(pid)).toBe(true);
      await expectAbsent(readme(created.path));
      const snapshotRef = (await findRecord(created.id))?.snapshotRef;
      expect(snapshotRef).toBeDefined();
      const snapshot = await git(repo, "rev-parse", snapshotRef!);
      abort.abort(new Error("fixture cancellation during deletion"));
      await fs.writeFile(release, "release");
      expect(await pending).toContain("managed worktree allocation lease operation was aborted");
      expect(isPidAlive(pid)).toBe(false);
      await expectAbsent(created.path);
      expect(await git(repo, "rev-parse", snapshotRef!)).toBe(snapshot);
      expect(await git(repo, "show", `${snapshotRef}:README.md`)).toBe("complete recoverable edit");
      expect(await findRecord(created.id)).toMatchObject({
        removedAt: expect.any(Number),
        snapshotRef,
      });
      await expect(
        git(repo, "show-ref", "--verify", `refs/openclaw/removals/${created.id}`),
      ).rejects.toThrow();
      const restored = await service.restore({ id: created.id });
      expect(await fs.readFile(readme(restored.path), "utf8")).toBe(contents);
    } finally {
      abort.abort();
      await fs.writeFile(release, "release");
      killPidIfAlive(pid);
      await pending;
    }
  });

  it.each(["\r", "\n"])("preserves failed-checkout evidence (%j)", async (separator) => {
    await git(path.join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main");
    await git(repo, "remote", "set-head", "origin", "-a");
    const name = "retry-evidence";
    const branch = `openclaw/${name}`;
    let allocatedPath: string | undefined;
    let checkoutFailed = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRunCommand(argv, options);
      const args = gitCommandArgs(argv);
      // Target the requested branch after any acceleration-template setup.
      if (!checkoutFailed && args[0] === "worktree" && args[1] === "add" && args.includes(branch)) {
        checkoutFailed = true;
        allocatedPath = args.at(-2);
        expect(result.code).toBe(0);
        return {
          ...result,
          code: 1,
          stderr: `Preparing worktree (new branch '${branch}')${separator}${`progress ${"x".repeat(200)}${separator}`.repeat(20)}fatal: checkout failed`,
        };
      }
      return result;
    });

    await expect(service.create({ repoRoot: repo, name })).rejects.toThrow("checkout failed");
    expect(checkoutFailed).toBe(true);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(allocatedPath).toBeDefined();
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(allocatedPath);
    expect(await git(allocatedPath!, "branch", "--show-current")).toBe(branch);
  });
  describe("removal timing", { concurrent: false }, () => {
    const trace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      parentSpanId: "abcdef1234567890",
      traceFlags: "01",
    };
    const messagePrefix = "slow managed worktree removal ";
    let clock = 120_000;
    let diagnosticsWereEnabled: boolean;
    let capture: ReturnType<typeof createDiagnosticLogRecordCapture>;
    const records = () =>
      capture.records.filter((record) => record.message.startsWith(messagePrefix));
    async function materialize(name: string) {
      const stateDir = path.join(root, "private-state");
      return materializeManagedWorktreeFixture({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        repoRoot: repo,
        name,
        now: Date.now(),
      });
    }
    async function expectTiming(
      worktree: ManagedWorktreeRecord,
      attributes: Record<string, unknown>,
    ) {
      await waitForDiagnosticEventsDrained();
      const emitted = records();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.attributes).toEqual({
        subsystem: "agents/worktrees",
        pid: process.pid,
        threadId,
        isMainThread,
        callbackEntered: true,
        omittedObservations: expect.any(Number),
        id: worktree.id,
        path: worktree.path,
        deferred: false,
        ...attributes,
      });
      return JSON.parse(emitted[0]!.message.slice(messagePrefix.length));
    }

    beforeEach(() => {
      service = new ManagedWorktreeService({
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "private-state") },
      });
      diagnosticsWereEnabled = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      resetLogger();
      setLoggerOverride({
        level: "info",
        consoleLevel: "silent",
        file: path.join(root, "runtime.log"),
      });
      clock += 120_000;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      capture = createDiagnosticLogRecordCapture();
    });

    afterEach(async () => {
      await waitForDiagnosticEventsDrained();
      capture.cleanup();
      await flushLogger();
      setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
      setLoggerOverride(null);
      resetLogger();
    });

    it("attributes admission, body and finalization without completing early", async () => {
      const worktree = await materialize("private-removal");
      const admissionEntered = createDeferredCore();
      const releaseAdmission = createDeferredCore();
      const bodyEntered = createDeferredCore();
      const releaseBody = createDeferredCore();
      const finalizeEntered = createDeferredCore();
      const releaseFinalize = createDeferredCore();
      let callbackResult: unknown;
      const acquire = stateLease.withOpenClawStateLeaseAsync;
      vi.spyOn(stateLease, "withOpenClawStateLeaseAsync").mockImplementation(async (...args) => {
        // Nested reconciliation settles inside the removal body.
        if (args[0].scope !== WORKTREE_MUTATION_LEASE_SCOPE) {
          return await acquire(...args);
        }
        admissionEntered.resolve();
        await releaseAdmission.promise;
        const result = await acquire(...args);
        callbackResult = result;
        finalizeEntered.resolve();
        await releaseFinalize.promise;
        return result;
      });
      vi.spyOn(commandExec, "runCommandWithTimeout")
        .mockImplementation(async (...args) => {
          const command = gitCommandArgs(args[0]);
          if (command[0] === "worktree" && command[1] === "remove") {
            clock += 500;
          } else if (command[0] === "branch" && command[1] === "-d") {
            clock += 600;
          }
          return await realRunCommand(...args);
        })
        .mockImplementationOnce(async (...args) => {
          bodyEntered.resolve();
          await releaseBody.promise;
          return await realRunCommand(...args);
        });
      vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation(async (...args) => {
        if (args[0].type === "worktree.snapshot") {
          clock += 400;
        }
        return await realRunGitWorkerOperation(...args);
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
        expect(records()).toEqual([]);
        clock += 300;
        releaseFinalize.resolve();
        const result = await pending;
        expect(result).toBe(callbackResult);
        expect(result.removed).toBe(true);
        const fields = await expectTiming(worktree, {
          durationMs: 3_100,
          admissionMs: 1_100,
          bodyMs: 1_700,
          finalizeMs: 300,
          preparationMs: 200,
          snapshotMs: 400,
          checkoutRemovalMs: 500,
          bodyFinalizeMs: 600,
          outcome: "returned",
          tracked: 1,
          untracked: 0,
        });
        expect(records()[0]?.trace).toEqual(trace);
        expect({ subsystem: "agents/worktrees", ...fields }).toEqual(records()[0]!.attributes);
      } finally {
        releaseAdmission.resolve();
        releaseBody.resolve();
        releaseFinalize.resolve();
        await Promise.allSettled([pending]);
      }
    });

    it("closes a failed snapshot stage and measures claim cleanup without deleting the checkout", async () => {
      const worktree = await materialize("snapshot-timing");
      const preservedContents = "kept until snapshot succeeds\n";
      await fs.writeFile(readme(worktree.path), preservedContents);
      const operationError = new Error("private snapshot input could not be read");
      let snapshotFailed = false;
      vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation(async (...args) => {
        if (args[0].type === "worktree.snapshot" && !snapshotFailed) {
          snapshotFailed = true;
          clock += 1_300;
          throw operationError;
        }
        return await realRunGitWorkerOperation(...args);
      });
      vi.spyOn(worktreeRunLease, "abortWorktreeRemoval").mockImplementation((...args) => {
        clock += 200;
        return realAbortWorktreeRemoval(...args);
      });
      const error = await service
        .remove({ id: worktree.id, reason: "private-snapshot-reason" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorktreeSnapshotError);
      expect(error).toMatchObject({ cause: operationError });
      expect(await fs.readFile(readme(worktree.path), "utf8")).toBe(preservedContents);
      const fields = await expectTiming(worktree, {
        durationMs: 1_500,
        admissionMs: 0,
        bodyMs: 1_500,
        finalizeMs: 0,
        preparationMs: 0,
        snapshotMs: 1_300,
        bodyFinalizeMs: 200,
        outcome: "threw",
      });
      expect(fields).toMatchObject({ tracked: null, untracked: null });
      await expect(service.remove({ id: worktree.id, reason: "retry" })).resolves.toMatchObject({
        removed: true,
      });
    });
  });
});
