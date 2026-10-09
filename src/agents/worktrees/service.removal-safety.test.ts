import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as checkoutGitOwner from "./checkout-git-config.js";
import * as checkoutInspection from "./checkout-inspection.js";
import * as gitOwner from "./git.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("managed removal custody", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-removal-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env });
    const withWorktreeGitConfig = checkoutGitOwner.withWorktreeGitConfig;
    // The native policy captures its functions at module initialization. Route
    // these synthetic faults through its action boundary, retaining real Git.
    vi.spyOn(checkoutGitOwner, "withWorktreeGitConfig").mockImplementation(
      async (cwd, sourceOnly, guard, operation) =>
        await withWorktreeGitConfig(
          cwd,
          sourceOnly,
          guard,
          async (policy) =>
            await operation(
              sourceOnly
                ? policy
                : {
                    ...policy,
                    run: (...args) => gitOwner.runGit(...args),
                    require: (...args) => gitOwner.requireGit(...args),
                  },
            ),
        ),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function materialize(name: string) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now: Date.now(),
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
    });
  }

  it("retains the recorded unpublished branch after HEAD is switched", async () => {
    const created = await materialize("switched");
    await git(created.path, "commit", "--allow-empty", "-m", "unpublished work");
    const tip = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "checkout", "-b", "replacement", "main");

    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      /branch|HEAD/,
    );

    expect(await git(repo, "rev-parse", created.branch)).toBe(tip);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("retains hidden dirty work instead of relying on status flags", async () => {
    const created = await materialize("hidden-dirty");
    await git(created.path, "update-index", "--assume-unchanged", "README.md");
    await fs.writeFile(path.join(created.path, "README.md"), "hidden change\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup?.outcome).toBe("retained-dirty");
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("hidden change\n");
  });

  it("finalizes source-only deletion after its producer and command scope are revoked", async () => {
    const created = await materializeManagedWorktreeFixture({
      env,
      name: "revoked-deletion",
      now: Date.now(),
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
      ownerKind: "session",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "restorable archived edit\n");
    const runGit = gitOwner.runGit;
    let current = true;
    let stopCommands = () => {};
    vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      const result = await runGit(cwd, args, options);
      if (args[0] === "worktree" && args[1] === "remove" && result.code === 0) {
        current = false;
        stopCommands();
      }
      return result;
    });

    const removed = await withCommandProcessScope(async (stop) => {
      stopCommands = stop;
      return await service.remove({
        id: created.id,
        reason: "owner-gc",
        commitGuard: () => {
          if (!current) {
            throw new Error("maintenance configuration changed");
          }
        },
      });
    });

    expect(current).toBe(false);
    expect(checkoutGitOwner.withWorktreeGitConfig).toHaveBeenCalledWith(
      created.path,
      true,
      expect.any(Object),
      expect.any(Function),
    );
    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: removed.snapshotRef,
    });
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    await expect(
      git(repo, "show-ref", "--verify", `refs/openclaw/removals/${created.id}`),
    ).rejects.toThrow();
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "restorable archived edit\n",
    );
  });

  it("releases lossless removal custody without recording an outcome after caller revocation", async () => {
    const created = await materialize("revoked-lossless");
    await fs.writeFile(path.join(created.path, "README.md"), "retained change\n");
    const inspect = checkoutInspection.inspectManagedWorktreeCheckout;
    const revoked = new Error("caller authority revoked after inspection");
    let current = true;
    vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout").mockImplementationOnce(
      async (...args) => {
        const result = await inspect(...args);
        current = false;
        return result;
      },
    );

    await expect(
      service.removeIfLossless(created.id, {
        commitGuard: () => {
          if (!current) {
            throw revoked;
          }
        },
      }),
    ).rejects.toBe(revoked);
    const record = getRegistryWorktree(env, created.id);
    expect(record?.removedAt).toBeUndefined();
    expect(record?.snapshotRef).toBeUndefined();
    expect(record?.runEndCleanup).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
      "retained change\n",
    );
    const lease = await acquireWorktreeRunLease(created.id, { env });
    await lease.release();
  });

  it("preserves an advanced tip even if upstream also advances after snapshot", async () => {
    const created = await materialize("late-tip");
    await git(repo, "config", `branch.${created.branch}.remote`, ".");
    await git(repo, "config", "--add", `branch.${created.branch}.merge`, "refs/heads/upstream");
    await git(repo, "branch", "upstream", "HEAD");
    const runGit = gitOwner.runGit;
    let advanced = "";
    vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        await git(created.path, "commit", "--allow-empty", "-m", "late unpublished work");
        advanced = await git(created.path, "rev-parse", "HEAD");
        await git(repo, "update-ref", "refs/heads/upstream", advanced);
      }
      return await runGit(cwd, args, options);
    });
    await expect(service.removeIfLossless(created.id)).rejects.toThrow(/not fully merged/);
    expect(await git(repo, "rev-parse", created.branch)).toBe(advanced);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup?.outcome).toBe("failed");
  });

  it("retains a new unpublished HEAD after the lossless inspection", async () => {
    const created = await materialize("after-inspection");
    const release = service.release.bind(service);
    let advanced = "";
    vi.spyOn(service, "release").mockImplementation(async (id) => {
      await release(id);
      await git(created.path, "commit", "--allow-empty", "-m", "new unpublished work");
      advanced = await git(created.path, "rev-parse", "HEAD");
    });

    await expect(service.removeIfLossless(created.id)).rejects.toThrow(
      "HEAD changed after lossless inspection",
    );
    expect(await git(repo, "rev-parse", created.branch)).toBe(advanced);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("does not overwrite a completed snapshot after a partial deletion timeout", async () => {
    const created = await materialize("partial");
    await fs.writeFile(path.join(created.path, "README.md"), "complete recovery content\n");
    const runGit = gitOwner.runGit;
    const fault = vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        await fs.unlink(path.join(created.path, "README.md"));
        return {
          ...(await runGit(cwd, ["status", "--porcelain"], options)),
          code: 1,
          stderr: "injected partial removal",
          termination: "timeout",
        };
      }
      return await runGit(cwd, args, options);
    });
    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      "injected partial removal",
    );
    fault.mockRestore();
    const snapshotRef = getRegistryWorktree(env, created.id)!.snapshotRef!;
    expect(getRegistryWorktree(env, created.id)?.gcRetry).toMatchObject({
      stage: "checkoutRemoval",
      attempts: 1,
    });
    const activity = getRegistryWorktree(env, created.id)!.lastActiveAt;
    await expect(service.acquire(created.id)).rejects.toThrow(/recover its preserved snapshot/);
    expect(getRegistryWorktree(env, created.id)!.lastActiveAt).toBe(activity);
    await updateRegistryWorktree(env, created.id, { lastActiveAt: activity + 1 });
    expect(getRegistryWorktree(env, created.id)?.gcRetry).toBeUndefined();
    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      /recover its preserved snapshot/,
    );
    const snapshot = await git(repo, "rev-parse", snapshotRef);
    await expect(service.remove({ id: created.id, reason: "retry" })).rejects.toThrow(
      "Previous worktree removal may be incomplete",
    );
    expect(await git(repo, "rev-parse", snapshotRef)).toBe(snapshot);
    expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("complete recovery content");
    expect(await git(repo, "rev-parse", `refs/openclaw/removals/${created.id}`)).toBe(snapshot);
  });

  it("expires a pending HEAD pin after snapshot-loss removal without orphaning it", async () => {
    let now = Date.now();
    service = new ManagedWorktreeService({ env, now: () => now });
    const created = await materialize("snapshot-loss-finalization");
    const nested = path.join(created.path, "nested");
    await fs.mkdir(nested);
    await git(nested, "init", "-b", "main");
    const head = await git(created.path, "rev-parse", "HEAD");
    const pendingRef = `refs/openclaw/removals/${created.id}`;
    const requireGit = gitOwner.requireGit;
    const fault = vi
      .spyOn(gitOwner, "requireGit")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "update-ref" && args[1] === "-d" && args[2] === pendingRef) {
          throw new Error("injected pending-ref deletion failure");
        }
        return await requireGit(cwd, args, options);
      });
    await expect(
      service.remove({ id: created.id, reason: "archive", allowSnapshotLoss: true }),
    ).rejects.toThrow("injected pending-ref deletion failure");
    fault.mockRestore();
    expect(getRegistryWorktree(env, created.id)).toMatchObject({ removedAt: now });
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
    expect(await git(repo, "rev-parse", pendingRef)).toBe(head);

    now += 31 * 24 * 60 * 60 * 1000;
    const lock = path.join(repo, ".git", `${pendingRef}.lock`);
    await fs.writeFile(lock, "", { flag: "wx" });
    try {
      const failed = await service.gc();
      expect(failed.snapshotsPruned).toBe(0);
      expect(getRegistryWorktree(env, created.id)).toBeDefined();
    } finally {
      await fs.unlink(lock);
    }
    const retried = await service.gc();
    expect(retried.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", pendingRef)).rejects.toThrow();
    expect(await git(repo, "rev-parse", created.branch)).toBe(head);
  });
});
