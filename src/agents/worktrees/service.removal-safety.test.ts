import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import * as commandRunner from "../../process/exec-runner.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import * as checkoutGitOwner from "./checkout-git-config.js";
import * as checkoutInspection from "./checkout-inspection.js";
import { git } from "./git-fixture.test-support.js";
import * as gitOwner from "./git.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { readExactStateSnapshot } from "./snapshot-exact-state.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("managed removal custody", () => {
  const read = (directory: string) => fs.readFile(path.join(directory, "README.md"), "utf8");
  const write = (directory: string, content: string) =>
    fs.writeFile(path.join(directory, "README.md"), content);

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
  ])("$outcome a clean partial worktree (missing=$missing)", async ({ missing }) => {
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
    const created = await materialize("missing-clean-blob", "session");
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
    expect(await read(created.path)).toBe("base\n");

    if (missing) {
      const failure: unknown = await service
        .remove({ id: created.id, reason: "archive" })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: expect.stringMatching(
          /missing blob [a-f0-9]{40,64}; repair the repository before retrying cleanup/,
        ),
      });
      expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
      expect(await read(created.path)).toBe("base\n");
    } else {
      const removed = await service.remove({ id: created.id, reason: "archive" });
      expect(removed.removed).toBe(true);
      expect(await git(repo, "rev-parse", `${removed.snapshotRef}^{tree}`)).toBe(tree);
      expect(await git(repo, "rev-parse", `${removed.snapshotRef}^`)).toBe(head);
      expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe("base");
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

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

describe("managed exact-state retirement", () => {
  const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");

  const exec = promisify(execFile);
  async function exactGit(cwd: string, ...args: string[]) {
    return (
      await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8" })
    ).stdout.trim();
  }
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  const initializeRepository = useManagedWorktreeTestRepository();
  const temps = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  type WorktreeRecord = Awaited<ReturnType<typeof materializeManagedWorktreeFixture>>;
  const fixture = (
    name: string,
    overrides: Partial<Parameters<typeof materializeManagedWorktreeFixture>[0]> = {},
  ) =>
    materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir,
      name,
      now: 1_800_000_000_000,
      ownerKind: "manual",
      ...overrides,
    });
  const indexPath = async (checkout: string) =>
    path.resolve(checkout, await exactGit(checkout, "rev-parse", "--git-path", "index"));
  const discardRecovery = (recoveryPath: string) =>
    exactGit(repo, "worktree", "remove", "--force", recoveryPath);
  const retire = async (
    record: WorktreeRecord,
    head: string,
    branchHead = head,
    indexSha256?: string,
  ) =>
    service.remove({
      id: record.id,
      reason: "exact metadata fixture",
      exactState: {
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head,
        branchHead,
        indexSha256: indexSha256 ?? sha256(await fs.readFile(await indexPath(record.path))),
      },
    });
  beforeEach(async () => {
    const root = temps.make("openclaw-exact-state-");
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  async function retiredFixture(name: string, prepare?: (checkout: string) => Promise<void>) {
    const created = await fixture(name);
    const head = await exactGit(created.path, "rev-parse", "HEAD");
    await exactGit(created.path, "checkout", "--detach", "HEAD");
    await prepare?.(created.path);
    const retired = await retire(created, head);
    return { created, retired, head };
  }

  it("round-trips detached HEAD, separate branch, split index and work bytes from snapshot objects", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "saved.secret\ncache.tmp\n");
    await exactGit(repo, "add", ".gitignore");
    await exactGit(repo, "commit", "-m", "ignore fixture data");
    await fs.writeFile(path.join(repo, "saved.secret"), "provisioned secret\n");
    const created = await fixture("exact-state", {
      ownerKind: "session",
      ownerId: "exact-state-owner",
      provisionedPaths: ["saved.secret"],
    });
    const branchHead = await exactGit(created.path, "rev-parse", "HEAD");
    await exactGit(created.path, "checkout", "--detach", "HEAD~1");
    const head = await exactGit(created.path, "rev-parse", "HEAD");
    // Keep native ignore/provisioning policy while HEAD differs from the recorded branch.
    await fs.writeFile(path.join(created.path, ".gitignore"), "saved.secret\ncache.tmp\n");
    await fs.writeFile(
      path.join(created.path, ".gitattributes"),
      "*.txt text eol=crlf\n*.utf16 working-tree-encoding=UTF-16LE\n",
    );
    await fs.writeFile(path.join(created.path, "raw.txt"), "raw LF bytes\n");
    await fs.writeFile(path.join(created.path, "encoded.utf16"), Buffer.from([0x78, 0]));
    await fs.writeFile(path.join(created.path, "README.md"), "staged half\n");
    await fs.writeFile(path.join(created.path, "staged-only.txt"), "only reachable from index\n");
    await fs.mkdir(path.join(created.path, "missing-parent", "nested"), { recursive: true });
    await fs.writeFile(
      path.join(created.path, "missing-parent", "nested", "staged-child.txt"),
      "nested index-only bytes\n",
    );
    await exactGit(created.path, "add", "README.md", "staged-only.txt", "missing-parent");
    await fs.rm(path.join(created.path, "missing-parent"), { recursive: true });
    const stagedBlob = await exactGit(created.path, "rev-parse", ":staged-only.txt");
    await fs.writeFile(path.join(created.path, "README.md"), "unstaged half\n");
    await fs.rm(path.join(created.path, "staged-only.txt"));
    await fs.writeFile(path.join(created.path, "untracked.sh"), "#!/bin/sh\nprintf exact\n", {
      mode: 0o751,
    });
    await fs.chmod(path.join(created.path, "untracked.sh"), 0o751);
    if (process.platform !== "win32") {
      await fs.symlink("README.md", path.join(created.path, "readme-link"));
    }
    await fs.writeFile(path.join(created.path, "saved.secret"), "saved ignored bytes\n", {
      mode: 0o600,
    });
    await fs.chmod(path.join(created.path, "saved.secret"), 0o600);
    await fs.writeFile(path.join(created.path, "cache.tmp"), "discarded native cache\n");
    await fs.utimes(path.join(created.path, "untracked.sh"), 1_600_000_000, 1_600_000_001);
    await exactGit(created.path, "update-index", "--split-index");
    const indexBytes = await fs.readFile(await indexPath(created.path));
    const indexSha256 = sha256(indexBytes);
    const status = await exactGit(created.path, "status", "--porcelain=v1", "-z");
    const staged = await exactGit(created.path, "diff", "--cached", "--binary");
    const unstaged = await exactGit(created.path, "diff", "--binary");
    const removed = await retire(created, head, branchHead, indexSha256);
    expect(removed.removed).toBe(true);
    expect(await fs.stat(created.path).catch(() => undefined)).toBeUndefined();
    expect(await exactGit(repo, "rev-parse", created.branch)).toBe(branchHead);
    expect(removed.recoveryPath).toBeTruthy();
    expect(removed.recoveryRetainedUntil).toBeGreaterThan(Date.now());
    // The independent snapshot must keep index-only objects alive after losing the retained checkout.
    await discardRecovery(removed.recoveryPath!);
    await exactGit(repo, "prune", "--expire=now");
    expect(await exactGit(repo, "cat-file", "-p", stagedBlob)).toBe("only reachable from index");
    const restored = await service.restore({ id: created.id });
    expect(await exactGit(restored.path, "rev-parse", "HEAD")).toBe(head);
    expect(
      await exec("git", ["-C", restored.path, "symbolic-ref", "-q", "HEAD"]).catch(() => null),
    ).toBeNull();
    expect(await exactGit(repo, "rev-parse", restored.branch)).toBe(branchHead);
    expect(sha256(await fs.readFile(await indexPath(restored.path)))).toBe(indexSha256);
    expect(await exactGit(restored.path, "status", "--porcelain=v1", "-z")).toBe(status);
    expect(await exactGit(restored.path, "diff", "--cached", "--binary")).toBe(staged);
    expect(await exactGit(restored.path, "diff", "--binary")).toBe(unstaged);
    await expect(fs.lstat(path.join(restored.path, "missing-parent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await read(restored.path, "saved.secret")).toBe("saved ignored bytes\n");
    expect(await read(restored.path, "cache.tmp").catch(() => undefined)).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mode & 0o777).toBe(0o751);
      expect((await fs.stat(path.join(restored.path, "saved.secret"))).mode & 0o777).toBe(0o600);
      expect(await fs.readlink(path.join(restored.path, "readme-link"))).toBe("README.md");
    }
    expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mtimeMs).toBe(
      1_600_000_001_000,
    );
    expect(await read(restored.path, "raw.txt")).toBe("raw LF bytes\n");
    expect(await fs.readFile(path.join(restored.path, "encoded.utf16"))).toEqual(
      Buffer.from([0x78, 0]),
    );
    expect(restored.snapshotRef).toBe(removed.snapshotRef);
    expect(await exactGit(repo, "rev-parse", `${removed.snapshotRef}^{commit}`)).toMatch(
      /^[a-f0-9]{40}$/u,
    );
  });
  it("keeps resolve-undo and cache-tree dependencies after the original index is gone", async () => {
    await exactGit(repo, "commit", "--allow-empty", "-m", "recorded branch tip");
    const record = await fixture("resolve-undo");
    const branchHead = await exactGit(record.path, "rev-parse", "HEAD");
    await exactGit(record.path, "checkout", "--detach", "HEAD~1");
    const head = await exactGit(record.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(record.path, "README.md"), "ours-only\n");
    await exactGit(record.path, "add", "README.md");
    const ours = await exactGit(record.path, "rev-parse", ":README.md");
    const oursTree = await exactGit(record.path, "write-tree");
    await fs.writeFile(path.join(record.path, "README.md"), "theirs-only\n");
    await exactGit(record.path, "add", "README.md");
    const theirs = await exactGit(record.path, "rev-parse", ":README.md");
    const theirsTree = await exactGit(record.path, "write-tree");
    await exactGit(record.path, "read-tree", oursTree);
    await exactGit(record.path, "read-tree", "-m", "-i", "HEAD", oursTree, theirsTree);
    await fs.writeFile(path.join(record.path, "README.md"), "resolved\n");
    await exactGit(record.path, "add", "README.md");
    const cacheTree = await exactGit(record.path, "write-tree");
    await exactGit(record.path, "update-index", "--index-version=4");
    expect(await exactGit(record.path, "ls-files", "--resolve-undo")).toContain(ours);
    const index = await fs.readFile(await indexPath(record.path));
    const result = await retire(record, head, branchHead, sha256(index));
    await discardRecovery(result.recoveryPath!);
    await exactGit(repo, "prune", "--expire=now");
    expect(await exactGit(repo, "cat-file", "-p", ours)).toBe("ours-only");
    expect(await exactGit(repo, "cat-file", "-p", theirs)).toBe("theirs-only");
    expect(await exactGit(repo, "cat-file", "-t", cacheTree)).toBe("tree");
    const restored = await service.restore({ id: record.id });
    expect(await fs.readFile(await indexPath(restored.path))).toEqual(index);
    await exactGit(restored.path, "checkout", "-m", "README.md");
    expect(await exactGit(restored.path, "ls-files", "--unmerged")).toContain(ours);
    expect(await exactGit(restored.path, "ls-files", "--unmerged")).toContain(theirs);
    expect(await read(restored.path, "README.md")).toContain("<<<<<<<");
  });
  it("refuses a fallback parent swapped to a symlink before publication", async () => {
    const { created, retired } = await retiredFixture("parent-swap", async (checkout) => {
      await fs.mkdir(path.join(checkout, "nested"));
      await fs.writeFile(path.join(checkout, "nested/child.txt"), "captured bytes\n");
    });
    await discardRecovery(retired.recoveryPath!);
    const outside = path.join(stateDir, "outside");
    await fs.mkdir(outside);
    const temporaryName = createHash("sha256")
      .update(Buffer.from("nested/child.txt").toString("hex"))
      .digest("hex");
    const write = fs.writeFile;
    let swapped = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const result = await write(...args);
      if (
        !swapped &&
        typeof args[0] === "string" &&
        path.basename(args[0]) === temporaryName &&
        path.basename(path.dirname(args[0])) === "files"
      ) {
        swapped = true;
        await fs.rename(
          path.join(created.path, "nested"),
          path.join(created.path, "original-nested"),
        );
        await fs.symlink(outside, path.join(created.path, "nested"), "dir");
      }
      return result;
    });
    await expect(service.restore({ id: created.id })).rejects.toThrow(
      /changed|directory|unexpected/i,
    );
    expect(swapped).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it.each([false, true])(
    "rejects a replaced captured-missing parent (symlink=%s)",
    async (symlink) => {
      const { created, retired } = await retiredFixture("missing-parent", async (checkout) => {
        await fs.mkdir(path.join(checkout, "missing-parent"));
        await fs.writeFile(path.join(checkout, "missing-parent", "staged.txt"), "index only\n");
        await exactGit(checkout, "add", "missing-parent");
        await fs.rm(path.join(checkout, "missing-parent"), { recursive: true });
      });
      await discardRecovery(retired.recoveryPath!);
      const outside = path.join(stateDir, "outside-parent");
      await fs.mkdir(outside);
      const target = path.join(created.path, "missing-parent");
      const write = fs.writeFile;
      let injected = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const result = await write(...args);
        if (
          !injected &&
          typeof args[0] === "string" &&
          path.basename(path.dirname(args[0])) === "files"
        ) {
          injected = true;
          if (symlink) {
            fsSync.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
          } else {
            fsSync.writeFileSync(target, "concurrent bytes\n");
          }
        }
        return result;
      });
      await expect(service.restore({ id: created.id })).rejects.toThrow(
        /non-directory parent|ENOTDIR/i,
      );
      expect(injected).toBe(true);
      expect(await fs.readdir(outside)).toEqual([]);
      if (symlink) {
        expect(await fs.realpath(target)).toBe(await fs.realpath(outside));
      } else {
        expect(await fs.readFile(target, "utf8")).toBe("concurrent bytes\n");
      }
      expect(await exactGit(repo, "rev-parse", retired.snapshotRef!)).toBeTruthy();
    },
  );

  it("does not apply restored metadata through an outside hard-link alias", async () => {
    const { created, retired } = await retiredFixture("hardlink");
    await discardRecovery(retired.recoveryPath!);
    const outside = path.join(stateDir, "outside-alias");
    const target = path.join(created.path, "README.md");
    const link = fsSync.linkSync;
    let linked = false;
    let originalMode = 0;
    let originalMtime = 0;
    vi.spyOn(fsSync, "linkSync").mockImplementation((...args) => {
      link(...args);
      if (!linked && String(args[1]) === target) {
        linked = true;
        link(target, outside);
        const observed = fsSync.statSync(outside);
        originalMode = observed.mode;
        originalMtime = observed.mtimeMs;
      }
    });
    await expect(service.restore({ id: created.id })).rejects.toThrow(/hard.link|shared.*inode/i);
    expect(linked).toBe(true);
    const final = await fs.stat(outside);
    expect(final.mode).toBe(originalMode);
    expect(final.mtimeMs).toBe(originalMtime);
  });

  it("reads raw high-bit Git snapshot names without treating them as traversal", async () => {
    const { retired, head } = await retiredFixture("raw-path");
    const snapshot = await exactGit(repo, "rev-parse", retired.snapshotRef!);
    const metadata = JSON.parse(await exactGit(repo, "show", snapshot + "^2:manifest.json"));
    const manifestFile = path.join(stateDir, "raw-manifest.json");
    for (const raw of ["aeae", "2e2e", "2e676974"]) {
      metadata.files[0].path = raw;
      await fs.writeFile(manifestFile, JSON.stringify(metadata));
      const blob = await exactGit(repo, "hash-object", "-w", manifestFile);
      const tree = spawnSync("git", ["-C", repo, "mktree"], {
        input: `100644 blob ${blob}\tmanifest.json\n`,
        encoding: "utf8",
      });
      expect(tree.status).toBe(0);
      const manifest = await exactGit(
        repo,
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        head,
        "-m",
        "raw path fixture",
      );
      const candidate = await exactGit(
        repo,
        "commit-tree",
        await exactGit(repo, "rev-parse", snapshot + "^{tree}"),
        "-p",
        head,
        "-p",
        manifest,
        "-m",
        "raw snapshot fixture",
      );
      const decoded = readExactStateSnapshot(repo, candidate, retired.snapshotRef!, undefined);
      if (raw === "aeae") {
        expect((await decoded)?.files[0]?.path).toBe(raw);
      } else {
        await expect(decoded).rejects.toThrow("Invalid path in exact-state snapshot");
      }
    }
  });
});
