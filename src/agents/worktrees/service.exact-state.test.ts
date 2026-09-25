import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { readExactStateSnapshot } from "./snapshot-exact-state.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8" })
  ).stdout.trim();
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("managed exact-state retirement", () => {
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
    const created = await materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir,
      name,
      now: 1_800_000_000_000,
      ownerKind: "manual",
    });
    const head = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "checkout", "--detach", "HEAD");
    await prepare?.(created.path);
    const indexPath = path.resolve(
      created.path,
      await git(created.path, "rev-parse", "--git-path", "index"),
    );
    const retired = await service.remove({
      id: created.id,
      reason: "exact metadata fixture",
      exactState: {
        ownerKind: created.ownerKind,
        ownerId: created.ownerId,
        createdAt: created.createdAt,
        lastActiveAt: created.lastActiveAt,
        head,
        branchHead: head,
        indexSha256: sha256(await fs.readFile(indexPath)),
      },
    });
    return { created, retired, head };
  }

  it.each([
    { split: false, retainSource: true },
    { split: true, retainSource: true },
    { split: false, retainSource: false },
    { split: true, retainSource: false },
  ])(
    "round-trips detached HEAD, separate branch, exact index and work bytes (split=$split, retained=$retainSource)",
    async ({ split, retainSource }) => {
      await fs.writeFile(path.join(repo, ".gitignore"), "saved.secret\ncache.tmp\n");
      await git(repo, "add", ".gitignore");
      await git(repo, "commit", "-m", "ignore fixture data");
      await fs.writeFile(path.join(repo, "saved.secret"), "provisioned secret\n");
      const created = await materializeManagedWorktreeFixture({
        env,
        repoRoot: repo,
        stateDir,
        name: "exact-state",
        now: 1_800_000_000_000,
        ownerKind: "session",
        ownerId: "exact-state-owner",
        provisionedPaths: ["saved.secret"],
      });
      const branchHead = await git(created.path, "rev-parse", "HEAD");
      await git(created.path, "checkout", "--detach", "HEAD~1");
      const head = await git(created.path, "rev-parse", "HEAD");
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
      await git(created.path, "add", "README.md", "staged-only.txt", "missing-parent");
      await fs.rm(path.join(created.path, "missing-parent"), { recursive: true });
      const stagedBlob = await git(created.path, "rev-parse", ":staged-only.txt");
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
      if (split) {
        await git(created.path, "update-index", "--split-index");
      }
      const indexPath = path.resolve(
        created.path,
        await git(created.path, "rev-parse", "--git-path", "index"),
      );
      const indexBytes = await fs.readFile(indexPath);
      const indexSha256 = sha256(indexBytes);
      const status = await git(created.path, "status", "--porcelain=v1", "-z");
      const staged = await git(created.path, "diff", "--cached", "--binary");
      const unstaged = await git(created.path, "diff", "--binary");
      const request = {
        id: created.id,
        reason: "explicit exact-state retirement",
        exactState: {
          ownerKind: created.ownerKind,
          ownerId: created.ownerId,
          createdAt: created.createdAt,
          lastActiveAt: created.lastActiveAt,
          head,
          branchHead,
          indexSha256,
        },
      };
      const removed = await service.remove(request);
      expect(removed.removed).toBe(true);
      expect(await fs.stat(created.path).catch(() => undefined)).toBeUndefined();
      expect(await git(repo, "rev-parse", created.branch)).toBe(branchHead);
      expect(removed.recoveryPath).toBeTruthy();
      expect(removed.recoveryRetainedUntil).toBeGreaterThan(Date.now());
      if (!retainSource) {
        // Simulate a lost retained checkout through native Git in this disposable
        // fixture; the independent snapshot must keep all index-only objects alive.
        await git(repo, "worktree", "remove", "--force", removed.recoveryPath!);
      }
      await git(repo, "prune", "--expire=now");
      expect(await git(repo, "cat-file", "-p", stagedBlob)).toBe("only reachable from index");
      const restored = await service.restore({ id: created.id });
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(head);
      expect(
        await exec("git", ["-C", restored.path, "symbolic-ref", "-q", "HEAD"]).catch(() => null),
      ).toBeNull();
      expect(await git(repo, "rev-parse", restored.branch)).toBe(branchHead);
      const restoredIndex = path.resolve(
        restored.path,
        await git(restored.path, "rev-parse", "--git-path", "index"),
      );
      expect(sha256(await fs.readFile(restoredIndex))).toBe(indexSha256);
      expect(await git(restored.path, "status", "--porcelain=v1", "-z")).toBe(status);
      expect(await git(restored.path, "diff", "--cached", "--binary")).toBe(staged);
      expect(await git(restored.path, "diff", "--binary")).toBe(unstaged);
      await expect(fs.lstat(path.join(restored.path, "missing-parent"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(path.join(restored.path, "saved.secret"), "utf8")).toBe(
        "saved ignored bytes\n",
      );
      expect(
        await fs.readFile(path.join(restored.path, "cache.tmp"), "utf8").catch(() => undefined),
      ).toBe(retainSource ? "discarded native cache\n" : undefined);
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mode & 0o777).toBe(0o751);
        expect((await fs.stat(path.join(restored.path, "saved.secret"))).mode & 0o777).toBe(0o600);
        expect(await fs.readlink(path.join(restored.path, "readme-link"))).toBe("README.md");
      }
      expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mtimeMs).toBe(
        1_600_000_001_000,
      );
      expect(await fs.readFile(path.join(restored.path, "raw.txt"), "utf8")).toBe("raw LF bytes\n");
      expect(await fs.readFile(path.join(restored.path, "encoded.utf16"))).toEqual(
        Buffer.from([0x78, 0]),
      );
      expect(restored.snapshotRef).toBe(removed.snapshotRef);
      expect(await git(repo, "rev-parse", `${removed.snapshotRef}^{commit}`)).toMatch(
        /^[a-f0-9]{40}$/u,
      );
    },
  );
  it("keeps resolve-undo and cache-tree dependencies after the original index is gone", async () => {
    await git(repo, "commit", "--allow-empty", "-m", "recorded branch tip");
    const record = await materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir,
      name: "resolve-undo",
      now: 1_800_000_000_000,
      ownerKind: "manual",
    });
    const branchHead = await git(record.path, "rev-parse", "HEAD");
    await git(record.path, "checkout", "--detach", "HEAD~1");
    const head = await git(record.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(record.path, "README.md"), "ours-only\n");
    await git(record.path, "add", "README.md");
    const ours = await git(record.path, "rev-parse", ":README.md");
    const oursTree = await git(record.path, "write-tree");
    await fs.writeFile(path.join(record.path, "README.md"), "theirs-only\n");
    await git(record.path, "add", "README.md");
    const theirs = await git(record.path, "rev-parse", ":README.md");
    const theirsTree = await git(record.path, "write-tree");
    await git(record.path, "read-tree", oursTree);
    await git(record.path, "read-tree", "-m", "-i", "HEAD", oursTree, theirsTree);
    await fs.writeFile(path.join(record.path, "README.md"), "resolved\n");
    await git(record.path, "add", "README.md");
    const cacheTree = await git(record.path, "write-tree");
    await git(record.path, "update-index", "--index-version=4");
    expect(await git(record.path, "ls-files", "--resolve-undo")).toContain(ours);
    const indexPath = path.resolve(
      record.path,
      await git(record.path, "rev-parse", "--git-path", "index"),
    );
    const index = await fs.readFile(indexPath);
    const result = await service.remove({
      id: record.id,
      reason: "resolve-undo proof",
      exactState: {
        ownerKind: record.ownerKind,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head,
        branchHead,
        indexSha256: sha256(index),
      },
    });
    await git(repo, "worktree", "remove", "--force", result.recoveryPath!);
    await git(repo, "prune", "--expire=now");
    expect(await git(repo, "cat-file", "-p", ours)).toBe("ours-only");
    expect(await git(repo, "cat-file", "-p", theirs)).toBe("theirs-only");
    expect(await git(repo, "cat-file", "-t", cacheTree)).toBe("tree");
    const restored = await service.restore({ id: record.id });
    const restoredIndex = path.resolve(
      restored.path,
      await git(restored.path, "rev-parse", "--git-path", "index"),
    );
    expect(await fs.readFile(restoredIndex)).toEqual(index);
    await git(restored.path, "checkout", "-m", "README.md");
    expect(await git(restored.path, "ls-files", "--unmerged")).toContain(ours);
    expect(await git(restored.path, "ls-files", "--unmerged")).toContain(theirs);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toContain("<<<<<<<");
  });
  it("refuses a fallback parent swapped to a symlink before publication", async () => {
    const created = await materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir,
      name: "parent-swap",
      now: 1_800_000_000_000,
      ownerKind: "manual",
    });
    const branchHead = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "checkout", "--detach", "HEAD");
    await fs.mkdir(path.join(created.path, "nested"));
    await fs.writeFile(path.join(created.path, "nested/child.txt"), "captured bytes\n");
    const indexPath = path.resolve(
      created.path,
      await git(created.path, "rev-parse", "--git-path", "index"),
    );
    const retired = await service.remove({
      id: created.id,
      reason: "parent swap fixture",
      exactState: {
        ownerKind: created.ownerKind,
        ownerId: created.ownerId,
        createdAt: created.createdAt,
        lastActiveAt: created.lastActiveAt,
        head: branchHead,
        branchHead,
        indexSha256: sha256(await fs.readFile(indexPath)),
      },
    });
    await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
    const outside = path.join(stateDir, "outside");
    await fs.mkdir(outside);
    const temporaryName = createHash("sha256")
      .update(Buffer.from("nested/child.txt").toString("hex"))
      .digest("hex");
    const write = fs.writeFile;
    let swapped = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const result = await write(...args);
      if (!swapped && typeof args[0] === "string" && args[0].endsWith("/files/" + temporaryName)) {
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
        await git(checkout, "add", "missing-parent");
        await fs.rm(path.join(checkout, "missing-parent"), { recursive: true });
      });
      await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
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
      expect(await git(repo, "rev-parse", retired.snapshotRef!)).toBeTruthy();
    },
  );

  it("does not apply restored metadata through an outside hard-link alias", async () => {
    const { created, retired } = await retiredFixture("hardlink");
    await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
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
    const snapshot = await git(repo, "rev-parse", retired.snapshotRef!);
    const metadata = JSON.parse(await git(repo, "show", snapshot + "^2:manifest.json"));
    const manifestFile = path.join(stateDir, "raw-manifest.json");
    for (const raw of ["aeae", "2e2e", "2e676974"]) {
      metadata.files[0].path = raw;
      await fs.writeFile(manifestFile, JSON.stringify(metadata));
      const blob = await git(repo, "hash-object", "-w", manifestFile);
      const tree = spawnSync("git", ["-C", repo, "mktree"], {
        input: `100644 blob ${blob}\tmanifest.json\n`,
        encoding: "utf8",
      });
      expect(tree.status).toBe(0);
      const manifest = await git(
        repo,
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        head,
        "-m",
        "raw path fixture",
      );
      const candidate = await git(
        repo,
        "commit-tree",
        await git(repo, "rev-parse", snapshot + "^{tree}"),
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
