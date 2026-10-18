import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { withTimeout } from "../../infra/fs-safe.js";
import * as commandRunner from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { updateRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeRecord,
  WorktreeSourceStage,
} from "./types.js";

const execFileAsync = promisify(execFile);
const expectAbsent = (file: string) =>
  expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
const writeScript = (file: string, contents: string) =>
  fs.writeFile(file, contents, { mode: 0o755 });

describe("ManagedWorktreeService repository code isolation", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let repo: string;
  let sentinel: string;
  let service: ManagedWorktreeService;
  let receipts: FixtureReceiptChannel;
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();
  const create = (name: string, options: Partial<CreateManagedWorktreeParams> = {}) =>
    service.create({ repoRoot: repo, name, baseRef: "HEAD", ...options });
  async function writeSetup(contents: string) {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(script));
    await writeScript(script, contents);
    return script;
  }

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    return () => receipts.close();
  });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-hooks-");
    repo = await initializeRepository(root);
    sentinel = path.join(repo, ".hook-ran");
    const hooks = path.join(repo, "git-hooks");
    await fs.mkdir(hooks);
    for (const hook of ["reference-transaction", "post-checkout"]) {
      await writeScript(path.join(hooks, hook), `#!/bin/sh\nprintf hook >> '${sentinel}'\n`);
    }
    await git("config", "core.hooksPath", "git-hooks");
    setRuntimeConfigSnapshot({});
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("never executes repository hooks through creation, removal and restore", async () => {
    const created = await create("restore");
    await service.remove({ id: created.id, reason: "test" });

    await expect(service.restore({ id: created.id })).resolves.toMatchObject({ id: created.id });
    await expectAbsent(sentinel);
  });

  it("never executes a repository filesystem monitor during lossless removal", async () => {
    const created = await create("fsmonitor");
    await fs.rm(sentinel, { force: true });
    const monitor = path.join(repo, "fsmonitor.sh");
    await writeScript(monitor, `#!/bin/sh\nprintf fsmonitor >> '${sentinel}'\nprintf 'token\\0'\n`);
    await git("config", "core.fsmonitor", monitor);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
    await expectAbsent(sentinel);
  });

  it.each([true, false])("runs setup only when enabled (%s)", async (runSetupScript) => {
    await writeSetup("#!/bin/sh\nprintf setup > setup-ran.txt\n");

    const progress: string[] = [];
    const onPromptReady = vi.fn(async () => {});
    const created = await create("setup", {
      runSetupScript,
      onProgress: (phase) => progress.push(phase),
      onPromptReady,
    });

    const setupOutput = path.join(created.path, "setup-ran.txt");
    if (runSetupScript) {
      await expect(fs.readFile(setupOutput, "utf8")).resolves.toBe("setup");
    } else {
      await expectAbsent(setupOutput);
    }
    await expectAbsent(sentinel);
    expect(progress).toEqual(runSetupScript ? ["checkout", "setup"] : ["checkout"]);
    if (runSetupScript) {
      expect(onPromptReady).not.toHaveBeenCalled();
    }
  });

  it("cancels setup and removes its unbound checkout", async ({ signal }) => {
    const setup = path.join(repo, ".openclaw");
    const pidFile = path.join(setup, "setup-pid");
    await writeSetup(
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/setup.mjs"\n`,
    );
    await fs.writeFile(
      path.join(setup, "setup.mjs"),
      `import { writeFileSync } from 'node:fs';
      ${fixtureReceiptClientSource(receipts.endpoint)}
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      sendReceipt(${JSON.stringify(pidFile)}, 'ready');
      setInterval(() => {}, 1000);
      `,
    );
    const controller = new AbortController();
    const creation = create("cancelled-setup", { signal: controller.signal });
    const outcome = creation.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const hasPid = () => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0;
      await withinTest(
        Promise.race([
          receipts.waitFor(pidFile, "ready"),
          // A child can exit before its side-channel receipt reaches the test.
          outcome.then((cause) => {
            if (!hasPid()) {
              throw new Error(`Child settled before writing ${pidFile}`, { cause });
            }
          }),
        ]),
        signal,
      );
      const pid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      controller.abort(new Error("setup cancelled"));
      expect(await withinTest(outcome, signal)).toBeInstanceOf(Error);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await service.list()).toEqual([]);
      expect(await git("worktree", "list", "--porcelain")).not.toContain("cancelled-setup");
      expect(await git("branch", "--list", "openclaw/cancelled-setup")).toBe("");
    } finally {
      controller.abort(new Error("release setup if the regression failed"));
      if (existsSync(pidFile)) {
        killPidIfAlive(Number.parseInt(readFileSync(pidFile, "utf8"), 10));
      }
      await outcome;
    }
  });

  it("does not fetch repository refs after caller authority closes", async () => {
    await expect(
      create("fenced-fetch", {
        baseRef: undefined,
        commitGuard: () => {
          throw new Error("authority closed");
        },
      }),
    ).rejects.toThrow("authority closed");
    await expectAbsent(path.join(repo, ".git", "FETCH_HEAD"));
    expect(await service.list()).toEqual([]);
  });

  it.each(["complete", "unwind"] as const)(
    "releases setup source before process settlement (%s)",
    async (mode) => {
      const script = await writeSetup("#!/bin/sh\nexit 0\n");
      const success: SpawnResult = {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
      type SourceScope = { active: boolean; checks: number };
      const callerContext = new AsyncLocalStorage<string>();
      const sourceContext = new AsyncLocalStorage<SourceScope>();
      const dispatched = createDeferredCore();
      const released = createDeferredCore();
      const aborted = createDeferredCore();
      const completion = createDeferredCore<SpawnResult>();
      const unwindFailure = new Error("source scope unwind failed");
      const completionFailure = new Error("accepted completion failed after cancellation");
      const events: string[] = [];
      let currentSource: SourceScope | undefined;
      let setupSource: SourceScope | undefined;
      let acceptedSignal: AbortSignal | undefined;
      const creationSettled = vi.fn();
      const withSource: WorktreeSourceStage = async (run) => {
        const scope: SourceScope = { active: true, checks: 0 };
        const previous = currentSource;
        currentSource = scope;
        return await sourceContext.run(scope, async () => {
          try {
            const result = await run({
              assertCurrent: () => {
                assert(scope.active, "source scope is closed");
                scope.checks += 1;
              },
            });
            if (mode === "unwind" && setupSource === scope) {
              throw unwindFailure;
            }
            return result;
          } finally {
            scope.active = false;
            currentSource = previous;
            if (setupSource === scope) {
              events.push("source-released");
              released.resolve();
            }
          }
        });
      };
      const runCommand = commandRunner.runCommandWithTimeout;
      const commandSpy = vi
        .spyOn(commandRunner, "runCommandWithTimeout")
        .mockImplementation((argv, options) => {
          if (argv[0] !== script) {
            const worktreeIndex = argv.indexOf("worktree");
            if (setupSource && worktreeIndex >= 0 && argv[worktreeIndex + 1] === "remove") {
              events.push("checkout-cleanup");
            }
            return runCommand(argv, options);
          }
          setupSource = currentSource;
          events.push("dispatch");
          dispatched.resolve();
          expect(setupSource?.active).toBe(true);
          expect(setupSource?.checks).toBeGreaterThan(0);
          expect(sourceContext.getStore()).toBeUndefined();
          expect(callerContext.getStore()).toBe("setup-caller");
          if (typeof options === "number" || !options.signal) {
            throw new Error("setup dispatch omitted cancellation ownership");
          }
          acceptedSignal = options.signal;
          acceptedSignal.addEventListener(
            "abort",
            () => {
              events.push("cancel");
              aborted.resolve();
            },
            { once: true },
          );
          return completion.promise.finally(() => {
            expect(setupSource?.active).toBe(false);
            expect(sourceContext.getStore()).toBeUndefined();
            expect(callerContext.getStore()).toBe("setup-caller");
            events.push("completion");
          });
        });
      const creation = callerContext.run("setup-caller", () =>
        create(`handoff-${mode}`, { withSource }),
      );
      const markSettled = <T>(result: T) => {
        creationSettled();
        return result;
      };
      const outcome = creation.then(
        (value) => markSettled({ value }),
        (error: unknown) => markSettled({ error }),
      );
      const premature = creation.then(() => {
        throw new Error("Worktree creation completed before setup readiness");
      });
      const waitForSetupSignal = (ready: Promise<void>, label: string) =>
        withTimeout(
          Promise.race([ready, premature]),
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          label,
        );
      try {
        await waitForSetupSignal(dispatched.promise, "setup dispatch");
        await waitForSetupSignal(released.promise, "setup source release");
        expect(creationSettled).not.toHaveBeenCalled();
        if (mode === "unwind") {
          await waitForSetupSignal(aborted.promise, "setup cancellation");
          expect(acceptedSignal?.reason).toBe(unwindFailure);
          expect(creationSettled).not.toHaveBeenCalled();
          completion.reject(completionFailure);
          const result = await outcome;
          assert("error" in result, "expected source unwind failure");
          expect(result.error).toBe(unwindFailure);
          expect(events).toEqual([
            "dispatch",
            "source-released",
            "cancel",
            "completion",
            "checkout-cleanup",
          ]);
          expect(await service.listRegistryRecords()).toEqual([]);
          expect(await git("branch", "--list", "openclaw/handoff-unwind")).toBe("");
        } else {
          expect(acceptedSignal?.aborted).toBe(false);
          completion.resolve(success);
          const result = await outcome;
          expect(result).toHaveProperty("value");
          expect(events).toEqual(["dispatch", "source-released", "completion"]);
          expect(await service.listRegistryRecords()).toHaveLength(1);
        }
      } finally {
        completion.resolve(success);
        await outcome;
        commandSpy.mockRestore();
      }
    },
  );

  it.each(["new", "reuse", "changed"] as const)(
    "preserves exact ownership after source unwind (%s)",
    async (mode) => {
      const ownerId = `publication-${mode}`;
      const params = { ownerKind: "session" as const, ownerId, runSetupScript: false };
      const existing = mode === "reuse" ? await create(ownerId, params) : undefined;
      const sourceFailure = new Error("source unwind after acknowledged worktree publication");
      let acknowledged: ManagedWorktreeRecord | undefined;
      const withSource: WorktreeSourceStage = async (run) => {
        const result = await run({ assertCurrent: () => {} });
        const record = await service.findLiveByOwner("session", ownerId);
        if (!record) {
          return result;
        }
        acknowledged = { ...record };
        if (mode === "changed") {
          await updateRegistryWorktree(
            { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
            record.id,
            { lastActiveAt: record.lastActiveAt + 1 },
          );
        }
        throw sourceFailure;
      };
      const failure = await create(ownerId, { ...params, withSource }).catch(
        (error: unknown) => error,
      );
      assert(acknowledged, "expected a published worktree before source unwind");
      const { id, path: checkout, branch, lastActiveAt } = acknowledged;
      const current = await service.findLiveByOwner("session", ownerId);
      if (mode === "new") {
        expect(failure).toBe(sourceFailure);
        expect(current).toBeUndefined();
        const retained = (await service.listRegistryRecords()).find((record) => record.id === id);
        expect(retained?.removedAt).toBeDefined();
        await expectAbsent(checkout);
      } else {
        expect(current).toMatchObject({ id, path: checkout, branch, ownerId });
        expect(current?.removedAt).toBeUndefined();
        expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("base\n");
        if (mode === "reuse") {
          expect(id).toBe(existing?.id);
          expect(failure).toBe(sourceFailure);
        } else {
          expect(current?.lastActiveAt).toBe(lastActiveAt + 1);
          assert(failure instanceof AggregateError);
          expect(failure.cause).toBe(sourceFailure);
          expect(failure.errors[0]).toBe(sourceFailure);
          expect(failure.errors[1]).toMatchObject({
            message: "Worktree changed before preparation rollback; checkout preserved.",
          });
        }
      }
    },
  );
});
