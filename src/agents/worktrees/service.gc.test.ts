import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import * as capacity from "./capacity.js";
import * as worktreeGit from "./git.js";
import { requireGit } from "./git.js";
import {
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import {
  useManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./service.test-support.js";
import { listTemplates, reserveTemplate } from "./template-registry.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeNestedRepository(root: string, name: string): Promise<string> {
  const nested = path.join(root, name);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, "init", "-b", "main");
  return nested;
}

describe("ManagedWorktreeService garbage collection", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  async function materializeDownstreamFixture(
    name: string,
    params: {
      ownerKind?: "manual" | "session" | "workboard";
      ownerId?: string;
      provisionedPaths?: readonly string[];
      repoRoot?: string;
    } = {},
  ) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      repoRoot: params.repoRoot ?? repo,
      stateDir,
      ...params,
    });
  }

  const materializeRunOwnedFixture = (
    name: string,
    ownerKind: "session" | "workboard",
    ownerId?: string,
  ) => materializeDownstreamFixture(name, { ownerKind, ownerId });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-gc-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exempts manual worktrees and garbage collects idle run-owned worktrees", async () => {
    const manual = await materializeDownstreamFixture("manual-idle");
    const created = await materializeRunOwnedFixture("idle-dead", "workboard");
    await git(repo, "worktree", "lock", "--reason", "openclaw pid=999999", created.path);
    now += IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed).toEqual([created.id]);
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeTruthy();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(manual.path)).toBeTruthy();
  });

  it("garbage collects ignored dependency trees under the Git output cap and restores edits", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore generated dependencies");
    const created = await materializeRunOwnedFixture("bounded-ignored", "workboard");
    const dependencies = path.join(created.path, "dependencies", "package");
    await fs.mkdir(dependencies, { recursive: true });
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(dependencies, `generated-dependency-file-${index}.txt`), "");
    }
    await fs.writeFile(path.join(created.path, "README.md"), "preserve local edit\n");
    now += IDLE_GC_MS + 1;
    const realRun = worktreeGit.runGitBuffered;
    const capped = vi
      .spyOn(worktreeGit, "runGitBuffered")
      .mockImplementation(async (cwd, args, options) => {
        return await realRun(
          cwd,
          args,
          cwd === created.path && args[0] === "ls-files" && args.includes("--ignored")
            ? { ...options, maxOutputBytes: 256 }
            : options,
        );
      });
    try {
      expect((await service.gc()).removed).toEqual([created.id]);
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      const restored = await service.restore({ id: created.id });
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
        "preserve local edit\n",
      );
      await expect(fs.stat(path.join(restored.path, "dependencies"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      capped.mockRestore();
    }
  });

  it("garbage collects a large Git index and restores local edits and deletions", async () => {
    const created = await materializeRunOwnedFixture("large-index", "workboard");
    const blob = await git(created.path, "rev-parse", "HEAD:README.md");
    // Build real tracked entries without creating thousands of files; their absence is a deletion.
    const entries = Array.from(
      { length: 180_000 },
      (_, index) => `100644 ${blob}\tfile-${String(index).padStart(6, "0")}\n`,
    ).join("");
    await requireGit(created.path, ["update-index", "--index-info"], { input: entries });
    const tree = await git(created.path, "write-tree");
    const parent = await git(created.path, "rev-parse", "HEAD");
    const commit = await git(created.path, "commit-tree", tree, "-p", parent, "-m", "large tree");
    await git(created.path, "update-ref", "HEAD", commit);
    await fs.writeFile(path.join(created.path, "README.md"), "preserve local edit\n");
    now += IDLE_GC_MS + 1;

    // Gateway cleanup runs on Node's main thread, whose stack limit differs from Vitest workers.
    const collected = await runNodeScript(
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `import { ManagedWorktreeService } from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};
         const service = new ManagedWorktreeService({ now: () => ${now} });
         console.log(JSON.stringify(await service.gc()));`,
      ],
      env,
      60_000,
      { requireProcessTreeExit: true },
    );
    expect(collected.error).toBeUndefined();
    expect(collected.status, collected.stderr).toBe(0);
    expect(JSON.parse(collected.stdout).removed, collected.stderr).toEqual([created.id]);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.restore({ id: created.id });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(commit);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "preserve local edit\n",
    );
    await expect(fs.stat(path.join(restored.path, "file-000000"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves an ignored unregistered nested linked worktree without cleanup warnings", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore agent checkout state");

    const created = await materializeRunOwnedFixture("ignored-nested", "workboard");
    const nested = path.join(created.path, ".claude", "worktrees", "nested-agent");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await git(repo, "worktree", "add", "--detach", nested, "HEAD");
    expect((await fs.stat(path.join(nested, ".git"))).isFile()).toBe(true);
    await fs.writeFile(path.join(nested, "local.txt"), "ignored agent state\n");
    expect(findLiveRegistryWorktreeByPath(env, nested)).toBeUndefined();
    expect(await git(created.path, "ls-files", "--others", "--exclude-standard")).toBe("");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-linked");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "ignored agent state\n",
      );
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(nested);
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it.each([
    ["an ignored nested foreign repository", true],
    ["an empty ignored nested foreign repository", false],
  ])("preserves %s", async (_description, hasLocalState) => {
    await fs.writeFile(path.join(repo, ".gitignore"), "vendor/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore vendored repositories");

    const created = await materializeRunOwnedFixture("ignored-foreign", "workboard");
    const nested = await initializeNestedRepository(created.path, "vendor/dependency");
    const localState = path.join(nested, "local.txt");
    if (hasLocalState) {
      await fs.writeFile(localState, "keep foreign repository state\n");
    } else {
      expect(await fs.readdir(nested)).toEqual([".git"]);
      expect(
        await git(created.path, "ls-files", "--others", "--ignored", "--exclude-standard"),
      ).toContain("vendor/dependency/");
    }
    expect(await git(created.path, "ls-files", "--others", "--exclude-standard")).toBe("");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-foreign");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect((await fs.stat(path.join(nested, ".git"))).isDirectory()).toBe(true);
      if (hasLocalState) {
        expect(await fs.readFile(localState, "utf8")).toBe("keep foreign repository state\n");
      }
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it("garbage collects modified provisioned files into the immutable snapshot", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=old-source\n");

    const created = await materializeDownstreamFixture("idle-rotated", {
      ownerKind: "workboard",
      provisionedPaths: [".env.local"],
    });
    await fs.rm(path.join(repo, ".worktreeinclude"));
    await fs.writeFile(path.join(created.path, ".env.local"), "value=rotated-only-copy\n");
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([created.id]);
    await fs.writeFile(path.join(repo, ".env.local"), "value=newer-source\n");
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, ".env.local"), "utf8")).toBe(
      "value=rotated-only-copy\n",
    );
  });

  it("uses owner activity to protect only active idle session worktrees", async () => {
    const active = await materializeRunOwnedFixture(
      "active-session",
      "session",
      "agent:main:active",
    );
    const inactive = await materializeRunOwnedFixture(
      "inactive-session",
      "session",
      "agent:main:inactive",
    );
    now += IDLE_GC_MS + 1;
    const shouldProtectOwner = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ shouldProtectOwner });

    expect(result.removed).toEqual([inactive.id]);
    expect(shouldProtectOwner).toHaveBeenCalledWith("session", "agent:main:active");
    expect(shouldProtectOwner).toHaveBeenCalledWith("session", "agent:main:inactive");
    expect(getRegistryWorktree(env, active.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, inactive.id)?.removedAt).toBeDefined();
  });

  it("protects foreign locks during idle garbage collection", async () => {
    const created = await materializeRunOwnedFixture("foreign-lock", "session");
    await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([]);
    expect(await fs.stat(created.path)).toBeTruthy();
  });

  it("protects a visible nested repository while collecting another idle worktree", async () => {
    const removable = await materializeRunOwnedFixture("removable", "workboard");
    now += 1;
    const nestedRecord = await materializeRunOwnedFixture("nested-idle", "workboard");
    const nested = await initializeNestedRepository(nestedRecord.path, "nested");
    await fs.writeFile(path.join(nested, "local.txt"), "visible nested state\n");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-visible");
    try {
      expect((await service.gc()).removed).toEqual([removable.id]);
      expect(await warnLogs.findText(`idle cleanup failed for ${nestedRecord.id}`)).toBeUndefined();
      expect(getRegistryWorktree(env, nestedRecord.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "visible nested state\n",
      );
      await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnLogs.cleanup();
    }
  });

  it("continues garbage collection when one repository control path is missing", async () => {
    const otherRepo = await initializeRepository(path.join(root, "other"));
    const removable = await materializeDownstreamFixture("other-removable", {
      repoRoot: otherRepo,
      ownerKind: "session",
    });
    now += 1;
    const broken = await materializeDownstreamFixture("missing-control", {
      ownerKind: "session",
    });
    await fs.rename(repo, path.join(root, "moved-repo"));
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(result).toMatchObject({
      outcome: "partial",
      issues: [{ stage: "idle", outcome: "failed", count: 1 }],
      limitsSatisfied: true,
    });
    expect(getRegistryWorktree(env, broken.id)?.removedAt).toBeUndefined();
  });

  it("evicts the least recently active run-owned worktrees over the count limit", async () => {
    const manual = await materializeDownstreamFixture("manual-kept");
    const oldest = await materializeRunOwnedFixture("count-oldest", "session", "agent:main:oldest");
    now += 1;
    const middle = await materializeRunOwnedFixture("count-middle", "workboard", "card-middle");
    now += 1;
    const newest = await materializeRunOwnedFixture("count-newest", "session", "agent:main:newest");

    const result = await service.gc({ limits: { maxCount: 2 } });

    expect(result.removed).toEqual([oldest.id, middle.id]);
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(oldest.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips active owners during count-limit eviction", async () => {
    const activeOldest = await materializeRunOwnedFixture(
      "limit-active",
      "session",
      "agent:main:active",
    );
    now += 1;
    const idle = await materializeRunOwnedFixture("limit-idle", "session", "agent:main:idle");
    const shouldProtectOwner = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ limits: { maxCount: 1 }, shouldProtectOwner });

    expect(result.removed).toEqual([idle.id]);
    expect(getRegistryWorktree(env, activeOldest.id)?.removedAt).toBeUndefined();
  });

  it.each([
    { limit: "count", limits: { maxCount: 1 } },
    { limit: "size", limits: { maxTotalSizeBytes: 60_000 } },
  ])("protects nested repositories during $limit limit eviction", async ({ limits }) => {
    const protectedRecord = await materializeRunOwnedFixture("limit-nested", "workboard");
    const nested = await initializeNestedRepository(protectedRecord.path, "nested");
    await fs.writeFile(path.join(nested, "local.txt"), "protected nested state\n");
    now += 1;
    const removable = await materializeRunOwnedFixture("limit-removable", "workboard");
    await fs.writeFile(path.join(removable.path, "blob.bin"), Buffer.alloc(100_000));

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-limit");
    try {
      expect((await service.gc({ limits })).removed).toEqual([removable.id]);
      expect(
        await warnLogs.findText(`cleanup limit removal failed for ${protectedRecord.id}`),
      ).toBeUndefined();
      expect(getRegistryWorktree(env, protectedRecord.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "protected nested state\n",
      );
      await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnLogs.cleanup();
    }
  });

  it("evicts oldest worktrees until total size fits the size limit", async () => {
    const oldest = await materializeRunOwnedFixture(
      "size-oldest",
      "session",
      "agent:main:size-old",
    );
    await fs.writeFile(path.join(oldest.path, "blob.bin"), Buffer.alloc(10_000));
    now += 1;
    const newest = await materializeRunOwnedFixture(
      "size-newest",
      "session",
      "agent:main:size-new",
    );

    const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });

    expect(result.removed).toEqual([oldest.id]);
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
  });

  it("keeps unmeasurable worktrees out of size accounting instead of counting zero", async () => {
    if (process.getuid?.() === 0) {
      return; // chmod-based EACCES cannot be simulated as root
    }
    const unreadable = await materializeRunOwnedFixture(
      "size-unreadable",
      "session",
      "agent:main:size-unreadable",
    );
    await fs.writeFile(path.join(unreadable.path, "blob.bin"), Buffer.alloc(10_000));
    const locked = path.join(unreadable.path, "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    try {
      const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });
      // The failed measurement excludes the record from the size total, so the
      // limit pass does not evict against a bogus zero-byte reading.
      expect(result.removed).toEqual([]);
      expect(result).toMatchObject({
        outcome: "partial",
        issues: [{ stage: "size", outcome: "failed", count: 1 }],
        limitsSatisfied: null,
      });
      expect(getRegistryWorktree(env, unreadable.id)?.removedAt).toBeUndefined();
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("counts a competing removal instead of evicting an extra worktree", async () => {
    const oldest = await materializeRunOwnedFixture(
      "race-oldest",
      "session",
      "agent:main:race-old",
    );
    now += 1;
    const middle = await materializeRunOwnedFixture(
      "race-middle",
      "session",
      "agent:main:race-mid",
    );
    now += 1;
    const newest = await materializeRunOwnedFixture(
      "race-newest",
      "session",
      "agent:main:race-new",
    );
    const realRemove = service.remove.bind(service);
    const removeSpy = vi
      .spyOn(service, "remove")
      .mockImplementationOnce(async (params: Parameters<typeof realRemove>[0]) => {
        // Simulate a concurrent cleanup winning the removal claim first.
        await realRemove({ ...params, reason: "concurrent-gc" });
        throw new WorktreeRemovalContentionError("finalized", "removal already claimed");
      });

    const result = await service.gc({ limits: { maxCount: 2 } });

    // The stale-count correction stops the pass at two live worktrees instead
    // of evicting middle as well.
    expect(result.removed).toEqual([]);
    expect(result).toMatchObject({
      outcome: "deferred",
      issues: [{ stage: "limits", outcome: "deferred", count: 1 }],
      limitsSatisfied: true,
    });
    expect(getRegistryWorktree(env, oldest.id)?.removedAt).toBeDefined();
    expect(getRegistryWorktree(env, middle.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    removeSpy.mockRestore();
  });

  it("leaves everything in place when limits are not exceeded", async () => {
    const created = await materializeRunOwnedFixture("under-limit", "session", "agent:main:under");

    const result = await service.gc({
      limits: { maxCount: 5, maxTotalSizeBytes: 1024 ** 3 },
    });

    expect(result.removed).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("enforces one hundred live checkouts by default without evicting manual work", async () => {
    for (let index = 0; index < 99; index += 1) {
      await materializeDownstreamFixture(`manual-${index}`);
    }
    const oldest = await materializeRunOwnedFixture("default-oldest", "session");
    now += 1;
    const newest = await materializeRunOwnedFixture("default-newest", "session");
    expect((await service.gc()).removed).toEqual([oldest.id]);
    expect(
      service.listRegistryRecords().filter((record) => record.removedAt === undefined),
    ).toHaveLength(100);
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
  });

  it("cleans recent retired owners while preserving a live lock and manual checkout", async () => {
    const retired = await materializeRunOwnedFixture(
      "archived-recent",
      "session",
      "agent:main:archived",
    );
    const busy = await materializeRunOwnedFixture("archived-busy", "session", "agent:main:busy");
    const manual = await materializeDownstreamFixture("archived-manual", {
      ownerId: "agent:main:archived",
    });
    await git(repo, "worktree", "lock", "--reason", `openclaw pid=${process.pid}`, busy.path);
    await fs.writeFile(path.join(retired.path, "uncommitted.txt"), "archived work\n");
    const result = await service.gc({ shouldRemoveOwner: () => true });
    expect(result.removed).toEqual([retired.id]);
    expect(getRegistryWorktree(env, busy.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    const restored = await service.restore({ id: retired.id });
    expect(await fs.readFile(path.join(restored.path, "uncommitted.txt"), "utf8")).toBe(
      "archived work\n",
    );
  });

  it("prunes expired snapshot refs and registry rows", async () => {
    const created = await materializeDownstreamFixture("expired");
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;

    const result = await service.gc();
    expect(result.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
  });

  it("counts a protected worktree once across idle and limit passes", async () => {
    const protectedRecord = await materializeRunOwnedFixture("protected", "session", "active");
    now += IDLE_GC_MS + 1;

    const result = await service.gc({
      limits: { maxCount: 0 },
      shouldProtectOwner: () => true,
    });

    expect(result).toEqual({
      removed: [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
      outcome: "completed",
      issues: [],
      protectedCount: 1,
      limitsSatisfied: false,
    });
    expect(getRegistryWorktree(env, protectedRecord.id)?.removedAt).toBeUndefined();
  });

  it("reports unknown size accounting while preserving confirmed count-limit progress", async () => {
    const manual = await materializeDownstreamFixture("unmeasurable");
    const removed = await materializeRunOwnedFixture("count-victim", "session");
    const measure = capacity.directorySizeBytes;
    vi.spyOn(capacity, "directorySizeBytes").mockImplementation(async (target, ...args) => {
      if (target === manual.path) {
        throw Object.assign(new Error("unreadable tree"), { code: "EACCES" });
      }
      return await measure(target, ...args);
    });

    const result = await service.gc({ limits: { maxCount: 1, maxTotalSizeBytes: 1024 ** 3 } });

    expect(result).toMatchObject({
      removed: [removed.id],
      outcome: "partial",
      issues: [{ stage: "size", outcome: "failed", count: 1 }],
      limitsSatisfied: null,
    });
    await expect(fs.stat(manual.path)).resolves.toBeDefined();
    await expect(fs.stat(removed.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a new unmeasured checkout on the under-limit path without evicting it", async () => {
    const original = await materializeRunOwnedFixture("measured", "session");
    const measure = capacity.directorySizeBytes;
    vi.spyOn(capacity, "directorySizeBytes").mockImplementationOnce(async (...args) => {
      const bytes = await measure(...args);
      now += 1;
      await materializeRunOwnedFixture("new-during-measurement", "session");
      return bytes;
    });

    const result = await service.gc({ limits: { maxCount: 1, maxTotalSizeBytes: 1024 ** 3 } });

    expect(result).toMatchObject({
      removed: [],
      outcome: "partial",
      issues: [{ stage: "size", outcome: "failed", count: 1 }],
      limitsSatisfied: null,
    });
    const live = service.listRegistryRecords().filter((record) => record.removedAt === undefined);
    expect(live.map((record) => record.name).toSorted()).toEqual([
      "measured",
      "new-during-measurement",
    ]);
    expect(live.some((record) => record.id === original.id)).toBe(true);
    for (const record of live) {
      await expect(fs.stat(record.path)).resolves.toBeDefined();
    }
  });

  it("aggregates failed and deferred limit operations without discarding progress", async () => {
    const failed = await materializeRunOwnedFixture("failed", "session");
    now += 1;
    const deferred = await materializeRunOwnedFixture("deferred", "session");
    now += 1;
    const removed = await materializeRunOwnedFixture("removed", "session");
    const remove = service.remove.bind(service);
    vi.spyOn(service, "remove").mockImplementation(async (params) => {
      if (params.id === failed.id) {
        throw new Error("snapshot inventory output limit exceeded");
      }
      if (params.id === deferred.id) {
        throw new WorktreeRemovalContentionError("busy", "another owner holds the claim");
      }
      return await remove(params);
    });

    const result = await service.gc({ limits: { maxCount: 0 } });

    expect(result).toMatchObject({
      removed: [removed.id],
      outcome: "partial",
      issues: [
        { stage: "limits", outcome: "failed", count: 1 },
        { stage: "limits", outcome: "deferred", count: 1 },
      ],
      limitsSatisfied: false,
    });
    expect(getRegistryWorktree(env, failed.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, deferred.id)?.removedAt).toBeUndefined();
  });

  async function reserveGcTemplate(id: string) {
    const templatePath = path.join(stateDir, "worktrees", ".templates", id);
    await fs.mkdir(templatePath, { recursive: true });
    reserveTemplate(
      env,
      {
        id,
        cacheKey: id,
        repoRoot: path.join(root, "missing-source"),
        commonDir: path.join(root, "missing-source", ".git"),
        worktreeRoot: path.join(stateDir, "worktrees"),
        path: templatePath,
        backend: "btrfs",
        sourceCommit: "a".repeat(40),
        contentKey: "b".repeat(64),
        status: "preparing",
        createdAt: now,
        lastUsedAt: now,
      },
      () => {},
    );
    return templatePath;
  }

  it("reports a template retirement failure while collecting another template", async () => {
    const failed = await reserveGcTemplate("failed-template");
    const collected = await reserveGcTemplate("collected-template");
    const rm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === failed) {
        throw Object.assign(new Error("template retirement denied"), { code: "EACCES" });
      }
      return await rm(target, options);
    });

    const result = await service.gc({ limits: {} });

    expect(result).toMatchObject({
      outcome: "partial",
      issues: [{ stage: "templates", outcome: "failed", count: 1 }],
      limitsSatisfied: true,
    });
    expect(listTemplates(env).map((record) => record.id)).toEqual(["failed-template"]);
    await expect(fs.stat(collected)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["OPENCLAW_STATE_LEASE_TIMEOUT", "deferred", "deferred"],
    ["OPENCLAW_STATE_LEASE_STORAGE_FAILED", "partial", "failed"],
    ["OPENCLAW_STATE_LEASE_LOST", "partial", "failed"],
  ] as const)(
    "reports template acquisition %s without skipping later stages",
    async (code, outcome, issueOutcome) => {
      await reserveGcTemplate("waiting-template");
      const orphan = path.join(stateDir, "worktrees", "orphan-fingerprint", "debris");
      await fs.mkdir(orphan, { recursive: true });
      vi.spyOn(stateLease, "withOpenClawStateLease").mockRejectedValueOnce(
        new stateLease.OpenClawStateLeaseError("allocation unavailable", { code }),
      );

      const result = await service.gc();

      expect(result).toMatchObject({
        orphansDeleted: 1,
        outcome,
        issues: [{ stage: "templates", outcome: issueOutcome, count: 1 }],
        limitsSatisfied: true,
      });
      expect(listTemplates(env)).toHaveLength(1);
      await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reports failed snapshot pruning while preserving confirmed removals", async () => {
    const expired = await materializeDownstreamFixture("failed-snapshot");
    const { snapshotRef } = await service.remove({ id: expired.id, reason: "retention" });
    const idle = await materializeRunOwnedFixture("removed-before-prune", "session");
    now += SNAPSHOT_RETENTION_MS + 1;
    const run = worktreeGit.requireGit;
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "update-ref" && args[1] === "-d" && args[2] === snapshotRef) {
        throw new Error("snapshot ref deletion failed");
      }
      return await run(cwd, args, options);
    });

    const result = await service.gc();

    expect(result).toMatchObject({
      removed: [idle.id],
      snapshotsPruned: 0,
      outcome: "partial",
      issues: [{ stage: "snapshots", outcome: "failed", count: 1 }],
    });
    expect(getRegistryWorktree(env, expired.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(idle.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
