import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandExec from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { deleteRegistryWorktree, getRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { acquireWorktreeRunLease, hasLiveWorktreeRunLease } from "./run-lease.js";
import { resolveRepository } from "./service-preparation.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();

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
        deleteRegistryWorktree(env, cleanupId);
      }
      cleanup();
    }),
  );
  const initialize = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;
  let record: ManagedWorktreeRecord;
  let snapshot: string;
  let head: string;
  let admin: string;

  const pinSnapshot = async () => {
    const update = execFileAsync("git", ["-C", repo, "update-ref", "--stdin"]);
    update.child.stdin?.end(
      `update refs/openclaw/snapshots/${record.id} ${snapshot}\nupdate refs/openclaw/removals/${record.id} ${snapshot}\n`,
    );
    await update;
  };
  const captureCheckout = async (message: string) => {
    await git(record.path, "add", ".");
    await git(record.path, "commit", "-m", message);
    head = await git(record.path, "rev-parse", "HEAD");
    snapshot = await git(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "clean capture");
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
    record = getRegistryWorktree(env, record.id)!;
    head = await git(repo, "rev-parse", "HEAD");
    admin = (await fs.readFile(path.join(record.path, ".git"), "utf8"))
      .trim()
      .slice("gitdir: ".length);
    snapshot = await git(
      repo,
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      head,
      "-m",
      "original completed capture",
    );
    const snapshotRef = `refs/openclaw/snapshots/${record.id}`;
    await pinSnapshot();
    await updateRegistryWorktree(env, record.id, { snapshotRef, provisionedState: [] });
    await fs.unlink(path.join(record.path, ".git"));
  });
  const recover = () => service.recoverRemoval({ id: record.id, snapshot });
  const pinsPreserved = async () => {
    expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
    expect(await git(repo, "rev-parse", `refs/openclaw/removals/${record.id}`)).toBe(snapshot);
    expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
  };

  it("reconstructs missing files without force, retires only its registration and retains the original capture", async () => {
    const sibling = path.join(root, "sibling");
    await git(repo, "worktree", "add", "--detach", sibling);
    await fs.rename(sibling, `${sibling}-parked`);
    await fs.unlink(path.join(record.path, "README.md"));
    const run = commandExec.runCommandWithTimeout;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("worktree") && argv.includes("remove")) {
        expect(argv).not.toContain("--force");
      }
      return await run(argv, options);
    });
    await expect(recover()).resolves.toMatchObject({
      removed: true,
      snapshotRef: record.snapshotRef ?? `refs/openclaw/snapshots/${record.id}`,
    });
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(admin)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "branch", "--list", record.branch)).toBe("");
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(sibling);
    expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("base");
    expect(
      await git(repo, "for-each-ref", "--format=%(refname)", `refs/openclaw/removals/${record.id}`),
    ).toBe("");
    expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
    await expect(recover()).resolves.toMatchObject({ removed: true });
  });

  it.each(["changed", "symlink", "directory"])(
    "preserves %s residual writes before any repair",
    async (kind) => {
      if (kind === "changed") {
        await fs.writeFile(path.join(record.path, "README.md"), "new work\n");
      }
      if (kind === "symlink") {
        await fs.unlink(path.join(record.path, "README.md"));
        await fs.symlink(path.join(repo, "README.md"), path.join(record.path, "README.md"));
      }
      if (kind === "directory") {
        await fs.mkdir(path.join(record.path, "foreign"));
      }
      const before = await fs.lstat(path.join(record.path, "README.md"));
      await expect(recover()).rejects.toThrow(/Changed|Foreign/);
      expect((await fs.lstat(path.join(record.path, "README.md"))).mode).toBe(before.mode);
      if (kind === "symlink") {
        expect(await fs.readlink(path.join(record.path, "README.md"))).toBe(
          path.join(repo, "README.md"),
        );
      } else {
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe(
          kind === "changed" ? "new work\n" : "base\n",
        );
      }
      if (kind === "directory") {
        expect((await fs.stat(path.join(record.path, "foreign"))).isDirectory()).toBe(true);
      }
      await expect(fs.lstat(path.join(record.path, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await pinsPreserved();
    },
  );

  it("rejects a replaced branch ref", async () => {
    const ref = `refs/heads/${record.branch}`;
    const newer = await git(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "new history");
    await git(repo, "update-ref", ref, newer);
    await expect(recover()).rejects.toThrow(/ref changed|branch changed/);
    expect(await git(repo, "rev-parse", ref)).toBe(newer);
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("refuses a live managed consumer before touching the partial checkout", async () => {
    await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
    // Model a pre-existing consumer; new admission correctly refuses a pending removal.
    await git(repo, "update-ref", "-d", `refs/openclaw/removals/${record.id}`, snapshot);
    const lease = await acquireWorktreeRunLease(record.id, { env });
    try {
      await pinSnapshot();
      await expect(recover()).rejects.toThrow(/busy|in use/);
      await pinsPreserved();
    } finally {
      await lease.release();
    }
  });

  it("retains newer writes arriving during reconstruction", async () => {
    await fs.unlink(path.join(record.path, "README.md"));
    const run = commandExec.runCommandWithTimeout;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("checkout-index")) {
        await fs.writeFile(path.join(record.path, "README.md"), "raced write\n");
      }
      return await run(argv, options);
    });
    await expect(recover()).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("raced write\n");
    await pinsPreserved();
  });

  it.each(["early-identity", "identity", "registry", "pending"])(
    "rejects a %s race before deletion",
    async (kind) => {
      const early = kind === "early-identity";
      const foreignText = early ? "new owner\n" : "new owner's work\n";
      await fs.unlink(path.join(record.path, "README.md"));
      const run = commandExec.runCommandWithTimeout;
      let injected = false;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await run(argv, options);
        if (
          !injected &&
          (early
            ? argv.includes(record.path) && argv.includes("--get-regexp")
            : argv.includes("checkout-index"))
        ) {
          injected = true;
          if (kind === "identity" || early) {
            await fs.rename(record.path, `${record.path}-original`);
            await fs.mkdir(record.path);
            await fs.writeFile(path.join(record.path, "foreign.txt"), foreignText);
          } else if (kind === "pending") {
            await git(repo, "update-ref", `refs/openclaw/removals/${record.id}`, head);
          } else {
            // Simulate a foreign lifecycle writer that bypassed the public removal claim.
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                db.prepare("UPDATE worktrees SET last_active_at=last_active_at+1 WHERE id=?").run(
                  record.id,
                );
              },
              { env },
            );
          }
        }
        return result;
      });
      await expect(recover()).rejects.toThrow(
        early ? "Checkout or original index changed" : undefined,
      );
      expect(injected).toBe(true);
      expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
      expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
      if (kind === "identity" || early) {
        const originalReadme = path.join(`${record.path}-original`, "README.md");
        expect(await fs.readFile(path.join(record.path, "foreign.txt"), "utf8")).toBe(foreignText);
        if (early) {
          expect(await fs.readdir(record.path)).toEqual(["foreign.txt"]);
          await expect(fs.stat(originalReadme)).rejects.toMatchObject({ code: "ENOENT" });
          await pinsPreserved();
        } else {
          expect(await fs.readFile(originalReadme, "utf8")).toBe("base\n");
        }
      } else {
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      }
    },
  );

  it("preserves an ignored file arriving after the last awaited inventory", async () => {
    const ignored = path.join(record.path, "late-output");
    await fs.writeFile(path.join(repo, ".git", "info", "exclude"), "late-output\n");
    const run = commandExec.runCommandWithTimeout;
    let injected = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (
        !injected &&
        argv.includes("rev-parse") &&
        argv.includes(`refs/heads/${record.branch}`) &&
        (await fs.stat(path.join(admin, "index.lock")).then(
          () => true,
          () => false,
        ))
      ) {
        injected = true;
        await fs.writeFile(ignored, "late owner bytes\n");
      }
      return result;
    });
    await expect(recover()).rejects.toThrow("Changed or foreign file: late-output");
    expect(injected).toBe(true);
    expect(await fs.readFile(ignored, "utf8")).toBe("late owner bytes\n");
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    await pinsPreserved();
  });

  it("preserves the pending pin when registry custody changes after removal publication", async () => {
    const run = commandExec.runCommandWithTimeout;
    let injected = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (
        !injected &&
        argv.includes("--git-common-dir") &&
        getRegistryWorktree(env, record.id)?.removedAt !== undefined
      ) {
        injected = true;
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare("UPDATE worktrees SET last_active_at=last_active_at+1 WHERE id=?").run(
              record.id,
            );
          },
          { env },
        );
      }
      return result;
    });
    await expect(recover()).rejects.toThrow("Completed removal lifecycle changed");
    expect(injected).toBe(true);
    expect(await git(repo, "rev-parse", `refs/openclaw/removals/${record.id}`)).toBe(snapshot);
    expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
    expect(getRegistryWorktree(env, record.id)?.lastActiveAt).toBe(record.lastActiveAt + 1);
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["admission", "native"])(
    "preserves a foreign target when the pin becomes symbolic during %s finalization",
    async (stage) => {
      const pending = `refs/openclaw/removals/${record.id}`;
      const foreign = "refs/tags/foreign-finalization";
      await git(repo, "update-ref", foreign, snapshot);
      const run = commandExec.runCommandWithTimeout;
      let injected = false;
      const fault = vi
        .spyOn(commandExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          if (stage === "native" && argv.includes("update-ref") && argv.includes("--stdin")) {
            injected = true;
            await git(repo, "symbolic-ref", pending, foreign);
          }
          const result = await run(argv, options);
          if (
            stage === "admission" &&
            argv.includes("--git-common-dir") &&
            getRegistryWorktree(env, record.id)?.removedAt !== undefined
          ) {
            await git(repo, "symbolic-ref", pending, foreign);
          }
          return result;
        });
      if (stage === "admission") {
        await expect(recover()).rejects.toThrow("must remain direct refs");
      } else {
        // Git CAS compares the resolved old OID; no-deref owns only the pending
        // ref itself even for an external writer racing after command admission.
        await expect(recover()).resolves.toMatchObject({ removed: true });
        expect(injected).toBe(true);
      }
      fault.mockRestore();
      expect(await git(repo, "rev-parse", foreign)).toBe(snapshot);
      expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
      if (stage === "admission") {
        expect(await git(repo, "symbolic-ref", pending)).toBe(foreign);
        expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
        await git(repo, "update-ref", "--no-deref", pending, snapshot);
        await expect(recover()).resolves.toMatchObject({ removed: true });
        expect(await git(repo, "rev-parse", foreign)).toBe(snapshot);
      } else {
        expect(await git(repo, "for-each-ref", "--format=%(refname)", pending)).toBe("");
      }
    },
  );

  it("preserves a checkout that reappears after its original path was absent", async () => {
    await fs.unlink(path.join(record.path, "README.md"));
    await fs.rmdir(record.path);
    await fs.writeFile(path.join(repo, ".git", "info", "exclude"), "new-owner\n");
    const run = commandExec.runCommandWithTimeout;
    let checkedIndex = false;
    let injected = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (argv.includes("diff-index")) {
        checkedIndex = true;
      }
      if (
        !injected &&
        checkedIndex &&
        argv.includes("rev-parse") &&
        argv.includes(`refs/heads/${record.branch}`)
      ) {
        injected = true;
        await fs.mkdir(record.path);
        await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
        await fs.writeFile(path.join(record.path, "README.md"), "base\n");
        await fs.writeFile(path.join(record.path, "new-owner"), "newer owner's bytes\n");
      }
      return result;
    });
    await expect(recover()).rejects.toThrow("Missing checkout reappeared");
    expect(injected).toBe(true);
    expect(await fs.readFile(path.join(record.path, "new-owner"), "utf8")).toBe(
      "newer owner's bytes\n",
    );
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    await pinsPreserved();
  });

  it("never executes a repository clean filter while deleting reconstructed source", async () => {
    await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
    await fs.writeFile(
      path.join(record.path, ".gitattributes"),
      "README.md filter=recovery-probe\n",
    );
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
    await fs.unlink(path.join(record.path, "README.md"));
    await fs.writeFile(path.join(record.path, "README.md"), "base\n");
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(marker, "utf8")).toBe("ran");
    await fs.unlink(marker);
    await fs.unlink(path.join(record.path, "README.md"));
    await fs.unlink(path.join(record.path, ".git"));
    await expect(recover()).resolves.toMatchObject({ removed: true });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("base");
  });

  it.each([false, true])(
    "recovers a retired missing checkout only if its path stays absent, reappeared=%s",
    async (reappeared) => {
      await fs.unlink(path.join(record.path, "README.md"));
      await fs.rmdir(record.path);
      await service.list();
      const retiredAt = getRegistryWorktree(env, record.id)?.removedAt;
      const pending = `refs/openclaw/removals/${record.id}`;
      if (reappeared) {
        await fs.mkdir(record.path);
        await fs.writeFile(path.join(record.path, "foreign.txt"), "new owner\n");
        await expect(recover()).rejects.toThrow("Retired checkout path reappeared");
        expect(await fs.readdir(record.path)).toEqual(["foreign.txt"]);
        expect(await fs.readFile(path.join(record.path, "foreign.txt"), "utf8")).toBe(
          "new owner\n",
        );
        expect(await git(repo, "rev-parse", pending)).toBe(snapshot);
        expect((await fs.stat(path.join(admin, "index"))).isFile()).toBe(true);
      } else {
        expect(retiredAt).toEqual(expect.any(Number));
        expect((await fs.stat(path.join(admin, "index"))).isFile()).toBe(true);
        await expect(recover()).resolves.toMatchObject({ removed: true });
        await expect(fs.stat(admin)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await git(repo, "branch", "--list", record.branch)).toBe("");
        expect(await git(repo, "for-each-ref", "--format=%(refname)", pending)).toBe("");
        expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
      }
      expect(getRegistryWorktree(env, record.id)?.removedAt).toBe(retiredAt);
    },
  );

  it.each(["split-base", "worktree-config", "metadata-mode"])(
    "preserves a newer retained %s before native deletion",
    async (kind) => {
      await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
      let target = path.join(admin, "index");
      if (kind === "split-base") {
        await git(record.path, "update-index", "--split-index");
        target = path.resolve(
          record.path,
          await git(record.path, "rev-parse", "--shared-index-path"),
        );
      } else if (kind === "worktree-config") {
        await git(repo, "config", "extensions.worktreeConfig", "true");
        await git(record.path, "config", "--worktree", "core.autocrlf", "false");
        target = path.join(admin, "config.worktree");
      }
      const prior = await fs.readFile(target);
      await fs.unlink(path.join(record.path, "README.md"));
      await fs.unlink(path.join(record.path, ".git"));
      const run = commandExec.runCommandWithTimeout;
      let injected = false;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await run(argv, options);
        if (argv.includes("checkout-index")) {
          injected = true;
          if (kind === "metadata-mode") {
            await fs.chmod(target, 0o755);
          } else {
            await fs.appendFile(target, "\n# newer owner bytes\n");
          }
        }
        return result;
      });
      await expect(recover()).rejects.toThrow("Original Git metadata changed");
      expect(injected).toBe(true);
      expect(await fs.readFile(target)).toEqual(
        kind === "metadata-mode"
          ? prior
          : Buffer.concat([prior, Buffer.from("\n# newer owner bytes\n")]),
      );
      if (kind === "metadata-mode") {
        expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
      }
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      await pinsPreserved();
    },
  );

  it("reconstructs clean symlink-file checkout representation", async () => {
    await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
    const filename = path.join(record.path, "representation");
    await fs.symlink("README.md", filename);
    await captureCheckout("capture checkout representation");
    await git(repo, "config", "core.symlinks", "false");
    await fs.unlink(filename);
    await git(record.path, "checkout-index", "-u", "representation");
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    expect((await fs.lstat(filename)).isFile()).toBe(true);
    expect(await fs.readFile(filename, "utf8")).toBe("README.md");
    await fs.unlink(filename);
    await fs.unlink(path.join(record.path, ".git"));
    await expect(recover()).resolves.toMatchObject({ removed: true });
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show", `${snapshot}:representation`)).toBe("README.md");
  });

  it("reconstructs native Unicode filename representation", async () => {
    await fs.writeFile(path.join(record.path, ".git"), `gitdir: ${admin}\n`);
    await git(repo, "config", "core.precomposeunicode", "true");
    const directory = "é-directory";
    const filename = "é-file.txt";
    await fs.mkdir(path.join(record.path, directory));
    await fs.writeFile(path.join(record.path, directory, filename), "captured Unicode\n");
    await captureCheckout("capture Unicode paths");
    const physicalDirectory =
      process.platform === "darwin" ? directory.normalize("NFD") : directory;
    const physicalFilename = process.platform === "darwin" ? filename.normalize("NFD") : filename;
    if (process.platform === "darwin") {
      await fs.rename(
        path.join(record.path, directory),
        path.join(record.path, "rename-directory"),
      );
      await fs.rename(
        path.join(record.path, "rename-directory"),
        path.join(record.path, physicalDirectory),
      );
      await fs.rename(
        path.join(record.path, physicalDirectory, filename),
        path.join(record.path, physicalDirectory, "rename-file"),
      );
      await fs.rename(
        path.join(record.path, physicalDirectory, "rename-file"),
        path.join(record.path, physicalDirectory, physicalFilename),
      );
    }
    expect(await fs.readdir(record.path)).toContain(physicalDirectory);
    expect(await fs.readdir(path.join(record.path, physicalDirectory))).toEqual([physicalFilename]);
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    const target = path.join(record.path, physicalDirectory, physicalFilename);
    await fs.unlink(target);
    await fs.unlink(path.join(record.path, ".git"));
    await expect(recover()).resolves.toMatchObject({ removed: true });
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show", `${snapshot}:${directory}/${filename}`)).toBe(
      "captured Unicode",
    );
  });

  it("preserves a newer administrative index after the checkout has already disappeared", async () => {
    await fs.unlink(path.join(record.path, "README.md"));
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
      const run = commandExec.runCommandWithTimeout;
      const fault = vi
        .spyOn(commandExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          const result = await run(argv, options);
          if (
            (stage === "listed-checkout" && argv.includes("worktree") && argv.includes("remove")) ||
            (stage === "branch" && argv.includes("branch") && argv.includes("-d")) ||
            (stage === "pin" && argv.includes("update-ref") && argv.includes("--stdin"))
          ) {
            throw new Error("interrupted after finalization effect");
          }
          return result;
        });
      await expect(recover()).rejects.toThrow("interrupted after finalization effect");
      fault.mockRestore();
      if (stage !== "pin") {
        await pinsPreserved();
      }
      if (stage === "listed-checkout") {
        await service.list();
        expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
      }
      await expect(recover()).resolves.toMatchObject({ removed: true });
      expect(await git(repo, "rev-parse", `refs/openclaw/snapshots/${record.id}`)).toBe(snapshot);
    },
  );
});
