import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPidFile } from "../../../test/helpers/process-wait.js";
import { withTimeout } from "../../infra/fs-safe.js";
import * as commandRunner from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { updateRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord, WorktreeSourceStage } from "./types.js";

const execFileAsync = promisify(execFile);

describe("ManagedWorktreeService repository code isolation", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let sentinel: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-hooks-")));
    repo = await initializeRepository(root);
    sentinel = path.join(repo, ".hook-ran");
    const hooks = path.join(repo, "git-hooks");
    await fs.mkdir(hooks);
    for (const hook of ["reference-transaction", "post-checkout"]) {
      await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\nprintf hook >> '${sentinel}'\n`, {
        mode: 0o755,
      });
    }
    await execFileAsync("git", ["-C", repo, "config", "core.hooksPath", "git-hooks"]);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never executes repository hooks when creating a worktree with setup enabled", async () => {
    const created = await service.create({ repoRoot: repo, name: "default", baseRef: "HEAD" });

    await expect(fs.stat(created.path)).resolves.toBeDefined();
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when creating a worktree with setup disabled", async () => {
    await service.create({
      repoRoot: repo,
      name: "without-setup",
      baseRef: "HEAD",
      runSetupScript: false,
    });

    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when snapshotting and removing a worktree", async () => {
    const created = await service.create({ repoRoot: repo, name: "remove", baseRef: "HEAD" });
    await fs.rm(sentinel, { force: true });

    await expect(service.remove({ id: created.id, reason: "test" })).resolves.toMatchObject({
      removed: true,
      snapshotRef: expect.any(String),
    });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when restoring a removed worktree", async () => {
    const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
    await service.remove({ id: created.id, reason: "test" });
    await fs.rm(sentinel, { force: true });

    await expect(service.restore({ id: created.id })).resolves.toMatchObject({ id: created.id });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes a repository filesystem monitor during lossless removal", async () => {
    const created = await service.create({ repoRoot: repo, name: "fsmonitor", baseRef: "HEAD" });
    await fs.rm(sentinel, { force: true });
    const monitor = path.join(repo, "fsmonitor.sh");
    await fs.writeFile(
      monitor,
      `#!/bin/sh\nprintf fsmonitor >> '${sentinel}'\nprintf 'token\\0'\n`,
      {
        mode: 0o755,
      },
    );
    await execFileAsync("git", ["-C", repo, "config", "core.fsmonitor", monitor]);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still executes the explicitly enabled worktree setup script", async () => {
    const setup = path.join(repo, ".openclaw");
    await fs.mkdir(setup);
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      "#!/bin/sh\nprintf setup > setup-ran.txt\n",
      { mode: 0o755 },
    );

    const progress: string[] = [];
    const created = await service.create({
      repoRoot: repo,
      name: "setup",
      baseRef: "HEAD",
      onProgress: (phase) => progress.push(phase),
    });

    await expect(fs.readFile(path.join(created.path, "setup-ran.txt"), "utf8")).resolves.toBe(
      "setup",
    );
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(progress).toEqual(["checkout", "setup"]);
  });

  it("stops setup and removes the unbound worktree when creation is aborted", async () => {
    const setup = path.join(repo, ".openclaw");
    const pidFile = path.join(setup, "setup-pid");
    const release = path.join(setup, "release");
    await fs.mkdir(setup);
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      '#!/bin/sh\nprintf "%s" "$$" > "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/setup-pid"\nwhile [ ! -f "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/release" ]; do sleep 0.05; done\n',
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const creation = service.create({
      repoRoot: repo,
      name: "cancelled-setup",
      baseRef: "HEAD",
      signal: controller.signal,
    });
    const outcome = creation.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const pid = await waitForPidFile(pidFile, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      controller.abort(new Error("setup cancelled"));
      expect(
        await withTimeout(
          outcome,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "worktree cancellation",
        ),
      ).toBeInstanceOf(Error);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await service.list()).toEqual([]);
      const worktrees = await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"]);
      expect(worktrees.stdout).not.toContain("cancelled-setup");
      const branches = await execFileAsync("git", [
        "-C",
        repo,
        "branch",
        "--list",
        "openclaw/cancelled-setup",
      ]);
      expect(branches.stdout.trim()).toBe("");
    } finally {
      await fs.writeFile(release, "release setup if the regression failed\n");
      await outcome;
    }
  });

  it("does not fetch repository refs after caller authority closes", async () => {
    await expect(
      service.create({
        repoRoot: repo,
        name: "fenced-fetch",
        commitGuard: () => {
          throw new Error("authority closed");
        },
      }),
    ).rejects.toThrow("authority closed");
    await expect(fs.access(path.join(repo, ".git", "FETCH_HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await service.list()).toEqual([]);
  });

  it.each(["complete", "unwind"] as const)(
    "releases setup source before process settlement (%s)",
    async (mode) => {
      const script = path.join(repo, ".openclaw", "worktree-setup.sh");
      await fs.mkdir(path.dirname(script));
      await fs.writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
      let creationSettled = false;
      const withSource: WorktreeSourceStage = async (run) => {
        const scope: SourceScope = { active: true, checks: 0 };
        const previous = currentSource;
        currentSource = scope;
        return await sourceContext.run(scope, async () => {
          try {
            const result = await run({
              assertCurrent: () => {
                if (!scope.active) {
                  throw new Error("source scope is closed");
                }
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
        service.create({ repoRoot: repo, name: `handoff-${mode}`, baseRef: "HEAD", withSource }),
      );
      const outcome = creation.then(
        (value) => {
          creationSettled = true;
          return { value };
        },
        (error: unknown) => {
          creationSettled = true;
          return { error };
        },
      );
      try {
        await withTimeout(
          dispatched.promise,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "setup dispatch",
        );
        await withTimeout(
          released.promise,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "setup source release",
        );
        expect(creationSettled).toBe(false);
        expect(events).not.toContain("completion");
        expect(events).not.toContain("checkout-cleanup");
        if (mode === "unwind") {
          await withTimeout(
            aborted.promise,
            SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            "setup cancellation",
          );
          expect(acceptedSignal?.reason).toBe(unwindFailure);
          expect(creationSettled).toBe(false);
          expect(events).not.toContain("checkout-cleanup");
          completion.reject(completionFailure);
          const result = await outcome;
          if (!("error" in result)) {
            throw new Error("expected source unwind failure");
          }
          expect(result.error).toBe(unwindFailure);
          expect(events).toEqual([
            "dispatch",
            "source-released",
            "cancel",
            "completion",
            "checkout-cleanup",
          ]);
          expect(await service.listRegistryRecords()).toEqual([]);
          const branches = await execFileAsync("git", [
            "-C",
            repo,
            "branch",
            "--list",
            "openclaw/handoff-unwind",
          ]);
          expect(branches.stdout.trim()).toBe("");
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
    "retains exact worktree ownership after acknowledged source unwind (%s)",
    async (mode) => {
      const ownerId = `publication-${mode}`;
      const params = {
        repoRoot: repo,
        name: ownerId,
        baseRef: "HEAD",
        ownerKind: "session" as const,
        ownerId,
        runSetupScript: false,
      };
      const existing = mode === "reuse" ? await service.create(params) : undefined;
      const sourceFailure = new Error("source unwind after acknowledged worktree publication");
      let acknowledged: ManagedWorktreeRecord | undefined;
      const withSource: WorktreeSourceStage = async (run) => {
        const result = await run({ assertCurrent: () => {} });
        const record = service.findLiveByOwner("session", ownerId);
        if (!record) {
          return result;
        }
        acknowledged = { ...record };
        if (mode === "changed") {
          updateRegistryWorktree(
            { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
            record.id,
            { lastActiveAt: record.lastActiveAt + 1 },
          );
        }
        throw sourceFailure;
      };
      let failure: unknown;
      try {
        await service.create({ ...params, withSource });
      } catch (error) {
        failure = error;
      }
      if (!acknowledged) {
        throw new Error("expected a published worktree before source unwind");
      }
      const published = acknowledged;
      if (mode === "new") {
        expect(failure).toBe(sourceFailure);
        expect(service.findLiveByOwner("session", ownerId)).toBeUndefined();
        const retained = (await service.listRegistryRecords()).find(
          (record) => record.id === published.id,
        );
        expect(retained?.removedAt).toBeDefined();
        await expect(fs.stat(published.path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const current = service.findLiveByOwner("session", ownerId);
        expect(current).toMatchObject({
          id: published.id,
          path: published.path,
          branch: published.branch,
          ownerId,
        });
        expect(current?.removedAt).toBeUndefined();
        expect(await fs.readFile(path.join(published.path, "README.md"), "utf8")).toBe("base\n");
        if (mode === "reuse") {
          expect(published.id).toBe(existing?.id);
          expect(failure).toBe(sourceFailure);
        } else {
          expect(current?.lastActiveAt).toBe(published.lastActiveAt + 1);
          expect(failure).toBeInstanceOf(AggregateError);
          if (!(failure instanceof AggregateError)) {
            throw new Error("expected source failure with rollback refusal");
          }
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
