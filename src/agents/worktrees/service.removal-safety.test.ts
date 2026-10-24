import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import * as gitExec from "../../infra/git-exec.js";
import * as commandRunner from "../../process/exec-runner.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
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
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
const read = (directory: string) => fs.readFile(path.join(directory, "README.md"), "utf8");
const write = (directory: string, content: string) =>
  fs.writeFile(path.join(directory, "README.md"), content);

describe("managed removal custody", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-removal-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    await captureRuntimeConfigAsyncReader()();
    service = new ManagedWorktreeService({ env });
    const withWorktreeGitConfig = checkoutGitOwner.withWorktreeGitConfig;
    // The native policy captures its functions at module initialization. Route
    // these synthetic faults through its action boundary, retaining real Git.
    vi.spyOn(checkoutGitOwner, "withWorktreeGitConfig").mockImplementation(
      (cwd, sourceOnly, guard, operation) =>
        withWorktreeGitConfig(cwd, sourceOnly, guard, (policy) =>
          operation(
            sourceOnly ? policy : { ...policy, run: gitOwner.runGit, require: gitOwner.requireGit },
          ),
        ),
    );
  });
  const registry = (id: string) => getRegistryWorktree(env, id);
  const remove = (id: string, reason = "archive") => service.remove({ id, reason });
  const materialize = (name: string, ownerKind?: ManagedWorktreeRecord["ownerKind"]) =>
    materializeManagedWorktreeFixture({
      env,
      name,
      now: Date.now(),
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
      ownerKind,
    });

  it.each([
    ["switched", /branch|HEAD/],
    ["after-inspection", /HEAD changed after lossless inspection/],
    ["during-removal", /not fully merged/],
  ] as const)("preserves unpublished work (%s)", async (stage, error) => {
    const created = await materialize(stage);
    let tip = "";
    const advance = async () => {
      await git(created.path, "commit", "--allow-empty", "-m", "unpublished work");
      tip = await git(created.path, "rev-parse", "HEAD");
    };
    if (stage === "switched") {
      await advance();
      await git(created.path, "checkout", "-b", "replacement", "main");
    } else if (stage === "after-inspection") {
      const release = service.release.bind(service);
      vi.spyOn(service, "release").mockImplementation(async (id) => {
        await release(id);
        await advance();
      });
    } else {
      await git(repo, "config", `branch.${created.branch}.remote`, ".");
      await git(repo, "config", "--add", `branch.${created.branch}.merge`, "refs/heads/upstream");
      await git(repo, "branch", "upstream", "HEAD");
      const run = gitOwner.runGit;
      vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          await advance();
          await git(repo, "update-ref", "refs/heads/upstream", tip);
        }
        return run(cwd, args, options);
      });
    }
    const operation =
      stage === "switched" ? remove(created.id) : service.removeIfLossless(created.id);
    await expect(operation).rejects.toThrow(error);
    expect(await git(repo, "rev-parse", created.branch)).toBe(tip);
    if (stage === "during-removal") {
      expect(registry(created.id)?.runEndCleanup?.outcome).toBe("failed");
    } else {
      await expect(fs.stat(created.path)).resolves.toBeDefined();
      expect(registry(created.id)?.removedAt).toBeUndefined();
    }
  });

  it("releases the checkout name while retired file deletion is pending", async () => {
    const created = await materialize("background-delete");
    const run = commandRunner.runCommandWithTimeout;
    const pending = createDeferred();
    const started = createDeferred();
    const completed = createDeferred();
    let retired = "";
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const target = argv.at(-1)!;
      if (
        !target.includes(".openclaw-removing-") ||
        path.dirname(target) !== path.dirname(created.path)
      ) {
        return await run(argv, options);
      }
      retired = target;
      started.resolve();
      await pending.promise;
      try {
        return await run(argv, options);
      } finally {
        completed.resolve();
      }
    });
    try {
      const removed = await remove(created.id);
      await started.promise;
      expect(await read(retired)).toBe("base\n");
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(repo, "branch", "--list", created.branch)).toBe("");
      const restored = await service.restore({ id: created.id });
      expect(await read(restored.path)).toBe("base\n");
      expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe("base");
    } finally {
      pending.resolve();
      await completed.promise;
    }
  });

  it("retains hidden dirty work instead of relying on status flags", async () => {
    const created = await materialize("hidden-dirty");
    await git(created.path, "update-index", "--assume-unchanged", "README.md");
    await write(created.path, "hidden change\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);
    expect(registry(created.id)?.runEndCleanup?.outcome).toBe("retained-dirty");
    expect(await read(created.path)).toBe("hidden change\n");
  });

  it.each([
    { missing: false, outcome: "archives" },
    { missing: true, outcome: "preserves" },
  ])(
    "$outcome a clean partial worktree without building a snapshot index (missing=$missing)",
    async ({ missing }) => {
      const source = repo;
      await git(source, "config", "uploadpack.allowFilter", "true");
      repo = path.join(root, "partial");
      await git(
        root,
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        pathToFileURL(source).href,
        repo,
      );
      const packDirectory = path.join(repo, ".git", "objects", "pack");
      const initialPacks = new Set(await fs.readdir(packDirectory));
      await git(repo, "checkout", "main");
      const blobPacks = (await fs.readdir(packDirectory)).filter(
        (name) => name.endsWith(".pack") && !initialPacks.has(name),
      );
      expect(blobPacks).toHaveLength(1);
      const created = await materializeManagedWorktreeFixture({
        env,
        name: "missing-clean-blob",
        now: Date.now(),
        repoRoot: repo,
        stateDir: env.OPENCLAW_STATE_DIR!,
        ownerKind: "session",
      });
      const head = await git(created.path, "rev-parse", "HEAD");
      const tree = await git(created.path, "rev-parse", "HEAD^{tree}");
      // Give Git an unambiguously non-racy stat entry before losing the promised pack.
      await fs.utimes(path.join(created.path, "README.md"), 1_600_000_000, 1_600_000_000);
      await git(created.path, "update-index", "--refresh");
      if (missing) {
        for (const pack of blobPacks) {
          await fs.unlink(path.join(packDirectory, pack));
          await fs.unlink(path.join(packDirectory, pack.replace(/\.pack$/, ".idx")));
        }
      }
      await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable"));
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");

      const commands = vi.spyOn(gitExec, "executeGitCommandBytes");
      if (missing) {
        const failure: unknown = await service
          .remove({ id: created.id, reason: "archive" })
          .catch((error: unknown) => error);
        expect(
          commands.mock.calls.some(([, args]) =>
            args.some((arg) => ["read-tree", "update-index", "write-tree"].includes(arg)),
          ),
        ).toBe(false);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({
          message: expect.stringMatching(
            /missing blob [a-f0-9]{40,64}; repair the repository before retrying cleanup/,
          ),
        });
        expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      } else {
        const removed = await service.remove({ id: created.id, reason: "archive" });
        expect(removed.removed).toBe(true);
        expect(await git(repo, "rev-parse", `${removed.snapshotRef}^{tree}`)).toBe(tree);
        expect(await git(repo, "rev-parse", `${removed.snapshotRef}^`)).toBe(head);
        expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe("base");
        await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          commands.mock.calls.some(([, args]) =>
            args.some((arg) => ["read-tree", "update-index", "write-tree"].includes(arg)),
          ),
        ).toBe(false);
      }
    },
  );

  it("finalizes source-only deletion after its producer and command scope are revoked", async () => {
    const created = await materialize("revoked-deletion", "session");
    await write(created.path, "restorable archived edit\n");
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
    expect(registry(created.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: removed.snapshotRef,
    });
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    await expect(
      git(repo, "show-ref", "--verify", `refs/openclaw/removals/${created.id}`),
    ).rejects.toThrow();
    const restored = await service.restore({ id: created.id });
    expect(await read(restored.path)).toBe("restorable archived edit\n");
  });

  it("releases lossless removal custody without recording an outcome after caller revocation", async () => {
    const created = await materialize("revoked-lossless");
    await write(created.path, "retained change\n");
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
    const record = registry(created.id);
    expect(record?.removedAt).toBeUndefined();
    expect(record?.snapshotRef).toBeUndefined();
    expect(record?.runEndCleanup).toBeUndefined();
    expect(await read(created.path)).toBe("retained change\n");
    const lease = await acquireWorktreeRunLease(created.id, { env });
    await lease.release();
  });

  it("does not overwrite a completed snapshot after a registration removal timeout", async () => {
    const created = await materialize("partial");
    await write(created.path, "complete recovery content\n");
    const runGit = gitOwner.runGit;
    const fault = vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          ...(await runGit(cwd, ["status", "--porcelain"], options)),
          code: 1,
          stderr: "injected partial removal",
          termination: "timeout",
        };
      }
      return await runGit(cwd, args, options);
    });
    await expect(remove(created.id)).rejects.toThrow("injected partial removal");
    fault.mockRestore();
    const { snapshotRef, gcRetry, lastActiveAt: activity } = registry(created.id)!;
    expect(gcRetry).toMatchObject({ stage: "checkoutRemoval", attempts: 1 });
    await expect(service.acquire(created.id)).rejects.toThrow(/recover its preserved snapshot/);
    expect(registry(created.id)!.lastActiveAt).toBe(activity);
    await updateRegistryWorktree(env, created.id, { lastActiveAt: activity + 1 });
    expect(registry(created.id)?.gcRetry).toBeUndefined();
    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      /recover its preserved snapshot/,
    );
    const snapshot = await git(repo, "rev-parse", snapshotRef!);
    await expect(remove(created.id, "retry")).rejects.toThrow(
      "Previous worktree removal may be incomplete",
    );
    expect(await git(repo, "rev-parse", snapshotRef!)).toBe(snapshot);
    expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("complete recovery content");
    expect(await git(repo, "rev-parse", `refs/openclaw/removals/${created.id}`)).toBe(snapshot);
  });

  it("expires a pending HEAD pin after snapshot-loss removal without orphaning it", async () => {
    const started = Date.now();
    service = new ManagedWorktreeService({ env });
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
    expect(registry(created.id)?.removedAt).toBeGreaterThanOrEqual(started);
    expect(registry(created.id)?.removedAt).toBeLessThanOrEqual(Date.now());
    expect(registry(created.id)?.snapshotRef).toBeUndefined();
    expect(await git(repo, "rev-parse", pendingRef)).toBe(head);

    await updateRegistryWorktree(env, created.id, {
      removedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 - 1,
    });
    const lock = path.join(repo, ".git", `${pendingRef}.lock`);
    await fs.writeFile(lock, "", { flag: "wx" });
    try {
      expect((await service.gc()).snapshotsPruned).toBe(0);
      expect(registry(created.id)).toBeDefined();
    } finally {
      await fs.unlink(lock);
    }
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(registry(created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", pendingRef)).rejects.toThrow();
    expect(await git(repo, "rev-parse", created.branch)).toBe(head);
  });
});
