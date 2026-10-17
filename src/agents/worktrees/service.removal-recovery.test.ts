import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandExec from "../../process/exec.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { deleteRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { resolveRepository } from "./repository-paths.js";
import * as runLease from "./run-lease.js";
import { hasLiveWorktreeRunLease } from "./run-lease.test-support.js";
import {
  expectFile,
  expectMissing,
  writeFile,
  afterCommand,
  git,
} from "./service-scenarios.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

describe("interrupted ordinary worktree removal recovery", () => {
  let env: NodeJS.ProcessEnv;
  let cleanupId: string | undefined;
  const stateDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      cleanup();
    }),
  );
  beforeAll(() => {
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDirs.make("openclaw-removal-state-") };
  });
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async ({ task }) => {
      vi.restoreAllMocks();
      if (task.result?.state !== "pass") {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      }
      if (cleanupId) {
        expect(hasLiveWorktreeRunLease(env, cleanupId)).toBe(false);
        await deleteRegistryWorktree(env, cleanupId);
      }
      cleanup();
    }),
  );
  let fixtureHead: string;
  let fixtureSnapshot: string;
  const initialize = useManagedWorktreeTestRepository(async (repo) => {
    fixtureHead = await git(repo, "rev-parse", "HEAD");
    fixtureSnapshot = await captureTree(repo, fixtureHead, "original completed capture");
  });
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;
  let record: ManagedWorktreeRecord;
  let snapshot: string;
  let head: string;
  let admin: string;
  const file = (...parts: string[]) => path.join(record.path, ...parts);
  const ref = (kind: "snapshots" | "removals") => `refs/openclaw/${kind}/${record.id}`;
  const registry = () => getRegistryWorktree(env, record.id);
  const attach = () => fs.writeFile(file(".git"), `gitdir: ${admin}\n`);
  const detach = () => fs.unlink(file(".git"));
  const removeReadme = () => fs.unlink(file("README.md"));
  const expectReadme = () => expectFile(record.path, "README.md", "base\n");
  const expectGit = async (expected: string, ...args: string[]) =>
    expect(await git(repo, ...args)).toBe(expected);
  const expectRemoved = () => expect(recover()).resolves.toMatchObject({ removed: true });
  const captureTree = (repository: string, parent: string, message: string) =>
    git(repository, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message);
  const changeRegistry = async (token: string) => {
    const patch = { lastActiveAt: record.lastActiveAt + 1 };
    await updateRegistryWorktree(env, record.id, patch, { removalToken: token });
  };
  const intercept = (effect: (argv: readonly string[], after: boolean) => Promise<void>) => {
    const run = commandExec.runCommandWithTimeout;
    return vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        await effect(argv, false);
        const result = await run(argv, options);
        await effect(argv, true);
        return result;
      });
  };
  const injectOnce = (
    matches: (argv: readonly string[]) => boolean | Promise<boolean>,
    effect: () => Promise<void>,
  ) => {
    let injected = false;
    const fault = afterCommand(commandExec, async (argv) => {
      if (!injected && (await matches(argv))) {
        injected = true;
        await effect();
      }
    });
    return { fault, expectInjected: () => expect(injected).toBe(true) };
  };

  const pinSnapshot = async () => {
    const update = execFileAsync("git", ["-C", repo, "update-ref", "--stdin"]);
    update.child.stdin?.end(
      `update ${ref("snapshots")} ${snapshot}\nupdate ${ref("removals")} ${snapshot}\n`,
    );
    await update;
  };
  const captureCheckout = async (message: string) => {
    await git(record.path, "add", ".");
    await git(record.path, "commit", "-m", message);
    head = await git(record.path, "rev-parse", "HEAD");
    snapshot = await captureTree(repo, head, "clean capture");
    await pinSnapshot();
  };

  beforeEach(async () => {
    cleanupId = undefined;
    root = await fs.realpath(dirs.make("openclaw-removal-recovery-"));
    repo = await initialize(root);
    service = new ManagedWorktreeService({ env });
    record = await materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir: path.join(root, "state"),
      name: "recovery",
      now: Date.now(),
    });
    cleanupId = record.id;
    const repository = await resolveRepository(repo);
    await updateRegistryWorktree(env, record.id, {
      repositoryIdentity: { repoRoot: repo, repoFingerprint: repository.fingerprint },
    });
    record = registry()!;
    head = fixtureHead;
    admin = (await fs.readFile(file(".git"), "utf8")).trim().slice("gitdir: ".length);
    snapshot = fixtureSnapshot;
    await pinSnapshot();
    await updateRegistryWorktree(env, record.id, {
      snapshotRef: ref("snapshots"),
      provisionedState: [],
    });
    await detach();
  });
  const recover = () => service.recoverRemoval({ id: record.id, snapshot });
  const observeRemovalClaim = () => {
    const claim = runLease.claimWorktreeRemoval;
    let token: string | undefined;
    vi.spyOn(runLease, "claimWorktreeRemoval").mockImplementation(async (...args) => {
      await claim(...args);
      token = args[1].token;
    });
    return () => {
      if (!token) {
        throw new Error("Recovery has not claimed removal");
      }
      return token;
    };
  };
  const pinsPreserved = async () => {
    await expectGit(snapshot, "rev-parse", ref("snapshots"));
    await expectGit(snapshot, "rev-parse", ref("removals"));
    expect(registry()?.removedAt).toBeUndefined();
  };

  it("reconstructs missing files without force, retires only its registration and retains the original capture", async () => {
    const sibling = path.join(root, "sibling");
    await git(repo, "worktree", "add", "--detach", sibling);
    await fs.rename(sibling, `${sibling}-parked`);
    await removeReadme();
    afterCommand(commandExec, async (argv) => {
      if (argv.includes("worktree") && argv.includes("remove")) {
        expect(argv).not.toContain("--force");
      }
    });
    await expect(recover()).resolves.toMatchObject({
      removed: true,
      snapshotRef: record.snapshotRef ?? ref("snapshots"),
    });
    await expectMissing(record.path);
    await expectMissing(admin);
    await expectGit("", "branch", "--list", record.branch);
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(sibling);
    await expectGit("base", "show", `${snapshot}:README.md`);
    await expectGit("", "for-each-ref", "--format=%(refname)", ref("removals"));
    expect(registry()?.removedAt).toEqual(expect.any(Number));
    await expectRemoved();
  });

  it.each(["changed", "symlink", "directory"])(
    "preserves %s residual writes before any repair",
    async (kind) => {
      if (kind === "changed") {
        await writeFile(record.path, "README.md", "new work\n");
      }
      if (kind === "symlink") {
        await fs.unlink(file("README.md"));
        await fs.symlink(path.join(repo, "README.md"), file("README.md"));
      }
      if (kind === "directory") {
        await fs.mkdir(file("foreign"));
      }
      const before = await fs.lstat(file("README.md"));
      await expect(recover()).rejects.toThrow(/Changed|Foreign/);
      expect((await fs.lstat(file("README.md"))).mode).toBe(before.mode);
      if (kind === "symlink") {
        expect(await fs.readlink(file("README.md"))).toBe(path.join(repo, "README.md"));
      } else {
        await expectFile(record.path, "README.md", kind === "changed" ? "new work\n" : "base\n");
      }
      if (kind === "directory") {
        expect((await fs.stat(file("foreign"))).isDirectory()).toBe(true);
      }
      await expect(fs.lstat(file(".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await pinsPreserved();
    },
  );

  it("rejects a replaced branch ref", async () => {
    const branchRef = `refs/heads/${record.branch}`;
    const newer = await captureTree(repo, head, "new history");
    await git(repo, "update-ref", branchRef, newer);
    await expect(recover()).rejects.toThrow(/ref changed|branch changed/);
    await expectGit(newer, "rev-parse", branchRef);
    await expectReadme();
  });

  it("refuses a live managed consumer before touching the partial checkout", async () => {
    await attach();
    // Model a pre-existing consumer; new admission correctly refuses a pending removal.
    await git(repo, "update-ref", "-d", ref("removals"), snapshot);
    const lease = await runLease.acquireWorktreeRunLease(record.id, { env });
    try {
      await pinSnapshot();
      await expect(recover()).rejects.toThrow(/busy|in use/);
      await pinsPreserved();
    } finally {
      await lease.release();
    }
  });

  it("retains newer writes arriving during reconstruction", async () => {
    await removeReadme();
    intercept(async (argv, after) => {
      if (!after && argv.includes("checkout-index")) {
        await writeFile(record.path, "README.md", "raced write\n");
      }
    });
    await expect(recover()).rejects.toThrow(/already exists/);
    await expectFile(record.path, "README.md", "raced write\n");
    await pinsPreserved();
  });

  it.each(["early-identity", "identity", "registry", "pending"])(
    "rejects a %s race before deletion",
    async (kind) => {
      const removalToken = observeRemovalClaim();
      const early = kind === "early-identity";
      const foreignText = early ? "new owner\n" : "new owner's work\n";
      await removeReadme();
      const injection = injectOnce(
        (argv) =>
          early
            ? argv.includes(record.path) && argv.includes("--get-regexp")
            : argv.includes("checkout-index"),
        async () => {
          if (kind === "identity" || early) {
            await fs.rename(record.path, `${record.path}-original`);
            await fs.mkdir(record.path);
            await fs.writeFile(file("foreign.txt"), foreignText);
          } else if (kind === "pending") {
            await git(repo, "update-ref", ref("removals"), head);
          } else {
            await changeRegistry(removalToken());
          }
        },
      );
      await expect(recover()).rejects.toThrow(
        early ? "Checkout or original index changed" : undefined,
      );
      injection.expectInjected();
      if (kind === "registry") {
        expect(registry()?.lastActiveAt).toBe(record.lastActiveAt + 1);
      }
      expect(registry()?.removedAt).toBeUndefined();
      await expectGit(snapshot, "rev-parse", ref("snapshots"));
      if (kind === "identity" || early) {
        const originalReadme = path.join(`${record.path}-original`, "README.md");
        await expectFile(record.path, "foreign.txt", foreignText);
        if (early) {
          expect(await fs.readdir(record.path)).toEqual(["foreign.txt"]);
          await expectMissing(originalReadme);
          await pinsPreserved();
        } else {
          expect(await fs.readFile(originalReadme, "utf8")).toBe("base\n");
        }
      } else {
        await expectReadme();
      }
    },
  );

  it("preserves an ignored file arriving after the last awaited inventory", async () => {
    const ignored = file("late-output");
    await fs.writeFile(path.join(repo, ".git", "info", "exclude"), "late-output\n");
    const injection = injectOnce(
      async (argv) =>
        argv.includes("rev-parse") &&
        argv.includes(`refs/heads/${record.branch}`) &&
        (await fs.stat(path.join(admin, "index.lock")).then(
          () => true,
          () => false,
        )),
      () => fs.writeFile(ignored, "late owner bytes\n"),
    );
    await expect(recover()).rejects.toThrow("Changed or foreign file: late-output");
    injection.expectInjected();
    expect(await fs.readFile(ignored, "utf8")).toBe("late owner bytes\n");
    await expectReadme();
    await pinsPreserved();
  });

  it("preserves the pending pin when registry custody changes after removal publication", async () => {
    const removalToken = observeRemovalClaim();
    const injection = injectOnce(
      (argv) => argv.includes("--git-common-dir") && registry()?.removedAt !== undefined,
      () => changeRegistry(removalToken()),
    );
    await expect(recover()).rejects.toThrow("Worktree registry changed during recovery");
    injection.expectInjected();
    await expectGit(snapshot, "rev-parse", ref("removals"));
    await expectGit(snapshot, "rev-parse", ref("snapshots"));
    expect(registry()?.lastActiveAt).toBe(record.lastActiveAt + 1);
    await expectMissing(record.path);
  });

  it.each(["admission", "native"])(
    "preserves a foreign target when the pin becomes symbolic during %s finalization",
    async (stage) => {
      const pending = ref("removals");
      const foreign = "refs/tags/foreign-finalization";
      await git(repo, "update-ref", foreign, snapshot);
      let injected = false;
      const fault = intercept(async (argv, after) => {
        if (
          !after &&
          stage === "native" &&
          argv.includes("update-ref") &&
          argv.includes("--stdin")
        ) {
          injected = true;
          await git(repo, "symbolic-ref", pending, foreign);
        }
        if (
          after &&
          stage === "admission" &&
          argv.includes("--git-common-dir") &&
          registry()?.removedAt !== undefined
        ) {
          await git(repo, "symbolic-ref", pending, foreign);
        }
      });
      if (stage === "admission") {
        await expect(recover()).rejects.toThrow("must remain direct refs");
      } else {
        // no-deref owns the pending ref, not its raced symbolic target.
        await expectRemoved();
        expect(injected).toBe(true);
      }
      fault.mockRestore();
      await expectGit(snapshot, "rev-parse", foreign);
      await expectGit(snapshot, "rev-parse", ref("snapshots"));
      if (stage === "admission") {
        await expectGit(foreign, "symbolic-ref", pending);
        expect(registry()?.removedAt).toEqual(expect.any(Number));
        await git(repo, "update-ref", "--no-deref", pending, snapshot);
        await expectRemoved();
        await expectGit(snapshot, "rev-parse", foreign);
      } else {
        await expectGit("", "for-each-ref", "--format=%(refname)", pending);
      }
    },
  );

  it("preserves a checkout that reappears after its original path was absent", async () => {
    await removeReadme();
    await fs.rmdir(record.path);
    await fs.writeFile(path.join(repo, ".git", "info", "exclude"), "new-owner\n");
    let checkedIndex = false;
    const injection = injectOnce(
      (argv) => {
        if (argv.includes("diff-index")) {
          checkedIndex = true;
        }
        return (
          checkedIndex && argv.includes("rev-parse") && argv.includes(`refs/heads/${record.branch}`)
        );
      },
      async () => {
        await fs.mkdir(record.path);
        await attach();
        await writeFile(record.path, "README.md", "base\n");
        await writeFile(record.path, "new-owner", "newer owner's bytes\n");
      },
    );
    await expect(recover()).rejects.toThrow("Missing checkout reappeared");
    injection.expectInjected();
    await expectFile(record.path, "new-owner", "newer owner's bytes\n");
    await expectReadme();
    await pinsPreserved();
  });

  it("never executes a repository clean filter while deleting reconstructed source", async () => {
    await attach();
    await writeFile(record.path, ".gitattributes", "README.md filter=recovery-probe\n");
    await captureCheckout("capture filter attribute");
    const marker = path.join(root, "filter-executed");
    const script = path.join(root, "filter.cjs");
    await fs.writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await git(
      repo,
      "config",
      "filter.recovery-probe.clean",
      `${quote(process.execPath)} ${quote(script)}`,
    );
    // Prove this repository program really runs through untrusted native status.
    await removeReadme();
    await writeFile(record.path, "README.md", "base\n");
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(marker, "utf8")).toBe("ran");
    await fs.unlink(marker);
    await removeReadme();
    await detach();
    await expectRemoved();
    await expectMissing(marker);
    await expectMissing(record.path);
    await expectGit("base", "show", `${snapshot}:README.md`);
  });

  it.each([false, true])(
    "recovers a retired missing checkout only if its path stays absent, reappeared=%s",
    async (reappeared) => {
      await removeReadme();
      await fs.rmdir(record.path);
      await service.list();
      const retiredAt = registry()?.removedAt;
      const pending = ref("removals");
      if (reappeared) {
        await fs.mkdir(record.path);
        await writeFile(record.path, "foreign.txt", "new owner\n");
        await expect(recover()).rejects.toThrow("Retired checkout path reappeared");
        expect(await fs.readdir(record.path)).toEqual(["foreign.txt"]);
        await expectFile(record.path, "foreign.txt", "new owner\n");
        await expectGit(snapshot, "rev-parse", pending);
        expect((await fs.stat(path.join(admin, "index"))).isFile()).toBe(true);
      } else {
        expect(retiredAt).toEqual(expect.any(Number));
        expect((await fs.stat(path.join(admin, "index"))).isFile()).toBe(true);
        await expectRemoved();
        await expectMissing(admin);
        await expectGit("", "branch", "--list", record.branch);
        await expectGit("", "for-each-ref", "--format=%(refname)", pending);
        await expectGit(snapshot, "rev-parse", ref("snapshots"));
      }
      expect(registry()?.removedAt).toBe(retiredAt);
    },
  );

  it.each(["split-base", "worktree-config", "metadata-mode"])(
    "preserves a newer retained %s before native deletion",
    async (kind) => {
      await attach();
      let target = path.join(admin, "index");
      if (kind === "split-base") {
        await git(record.path, "update-index", "--split-index");
        target = path.resolve(
          record.path,
          await git(record.path, "rev-parse", "--shared-index-path"),
        );
      } else {
        await git(repo, "config", "extensions.worktreeConfig", "true");
        await git(record.path, "config", "--worktree", "core.autocrlf", "false");
        target = path.join(admin, "config.worktree");
      }
      const prior = await fs.readFile(target);
      await removeReadme();
      await detach();
      const injection = injectOnce(
        (argv) => argv.includes("checkout-index"),
        () => fs.appendFile(target, "\n# newer owner bytes\n"),
      );
      await expect(recover()).rejects.toThrow("Original Git metadata changed");
      injection.expectInjected();
      expect(await fs.readFile(target)).toEqual(
        Buffer.concat([prior, Buffer.from("\n# newer owner bytes\n")]),
      );
      await expectReadme();
      await pinsPreserved();
    },
  );

  it("reconstructs clean symlink-file checkout representation", async () => {
    await attach();
    const filename = file("representation");
    await fs.symlink("README.md", filename);
    await captureCheckout("capture checkout representation");
    await git(repo, "config", "core.symlinks", "false");
    await fs.unlink(filename);
    await git(record.path, "checkout-index", "-u", "representation");
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    expect((await fs.lstat(filename)).isFile()).toBe(true);
    expect(await fs.readFile(filename, "utf8")).toBe("README.md");
    await fs.unlink(filename);
    await detach();
    await expectRemoved();
    await expectMissing(record.path);
    await expectGit("README.md", "show", `${snapshot}:representation`);
  });

  it("reconstructs native Unicode filename representation", async () => {
    await attach();
    await git(repo, "config", "core.precomposeunicode", "true");
    const directory = "é-directory";
    const filename = "é-file.txt";
    await fs.mkdir(file(directory));
    await fs.writeFile(file(directory, filename), "captured Unicode\n");
    await captureCheckout("capture Unicode paths");
    const physicalDirectory =
      process.platform === "darwin" ? directory.normalize("NFD") : directory;
    const physicalFilename = process.platform === "darwin" ? filename.normalize("NFD") : filename;
    if (process.platform === "darwin") {
      await fs.rename(file(directory), file("rename-directory"));
      await fs.rename(file("rename-directory"), file(physicalDirectory));
      await fs.rename(file(physicalDirectory, filename), file(physicalDirectory, "rename-file"));
      await fs.rename(
        file(physicalDirectory, "rename-file"),
        file(physicalDirectory, physicalFilename),
      );
    }
    expect(await fs.readdir(record.path)).toContain(physicalDirectory);
    expect(await fs.readdir(file(physicalDirectory))).toEqual([physicalFilename]);
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    const target = file(physicalDirectory, physicalFilename);
    await fs.unlink(target);
    await detach();
    await expectRemoved();
    await expectMissing(record.path);
    await expectGit("captured Unicode", "show", `${snapshot}:${directory}/${filename}`);
  });

  it("preserves a newer administrative index after the checkout has already disappeared", async () => {
    await removeReadme();
    await fs.rmdir(record.path);
    const blob = await git(repo, "hash-object", "README.md");
    await execFileAsync(
      "git",
      ["-C", repo, "update-index", "--add", "--cacheinfo", `100644,${blob},new.txt`],
      { env: { ...process.env, GIT_INDEX_FILE: path.join(admin, "index") } },
    );
    const indexBytes = await fs.readFile(path.join(admin, "index"));
    await expect(recover()).rejects.toThrow("Original index differs");
    expect(await fs.readFile(path.join(admin, "index"))).toEqual(indexBytes);
    await pinsPreserved();
  });

  it.each(["listed-checkout", "branch", "pin"])(
    "retries an interruption after %s finalization without recapturing source",
    async (stage) => {
      const fault = afterCommand(commandExec, async (argv) => {
        if (
          (stage === "listed-checkout" && argv.includes("worktree") && argv.includes("remove")) ||
          (stage === "branch" && argv.includes("branch") && argv.includes("-d")) ||
          (stage === "pin" && argv.includes("update-ref") && argv.includes("--stdin"))
        ) {
          throw new Error("interrupted after finalization effect");
        }
      });
      await expect(recover()).rejects.toThrow("interrupted after finalization effect");
      fault.mockRestore();
      if (stage !== "pin") {
        await pinsPreserved();
      }
      if (stage === "listed-checkout") {
        await service.list();
        expect(registry()?.removedAt).toEqual(expect.any(Number));
      }
      await expectRemoved();
      await expectGit(snapshot, "rev-parse", ref("snapshots"));
    },
  );
});
