import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import * as backoff from "../../infra/backoff.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import * as pidAlive from "../../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import * as worktreeCapacity from "./capacity.js";
import * as worktreeGit from "./git.js";
import { requireGit } from "./git.js";
import { findLiveRegistryWorktreeByPath, getRegistryWorktree } from "./registry.js";
import { managedWorktreeGcEntrypoint } from "./service-gc-runtime.test-support.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import {
  useManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

/** Commits both sides of a modify/delete conflict for a tracked `entry` file. */
async function commitConflictedParent(repo: string): Promise<void> {
  await fs.writeFile(path.join(repo, "entry"), "base\n");
  await git(repo, "add", "entry");
  await git(repo, "commit", "-m", "add tracked parent");
  await git(repo, "checkout", "-q", "-b", "theirs");
  await fs.writeFile(path.join(repo, "entry"), "modified\n");
  await git(repo, "commit", "-am", "modify parent");
  await git(repo, "checkout", "-q", "main");
  await git(repo, "rm", "-q", "entry");
  await git(repo, "commit", "-m", "delete parent");
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
    await closeOpenClawStateDatabaseAsync();
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

  async function capUntrackedListing(checkoutPath: string) {
    const realRun = worktreeGit.runGitBuffered;
    return vi
      .spyOn(worktreeGit, "runGitBuffered")
      .mockImplementation(async (cwd, args, options) => {
        return await realRun(
          cwd,
          args,
          cwd === checkoutPath &&
            args[0] === "ls-files" &&
            args.includes("--others") &&
            !args.includes("--ignored")
            ? { ...options, maxOutputBytes: 256 }
            : options,
        );
      });
  }

  it("garbage collects untracked trees over the Git output cap and restores them", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "cache/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore caches");
    const created = await materializeRunOwnedFixture("bounded-untracked", "workboard");
    const generated = path.join(created.path, "generated", "package");
    await fs.mkdir(path.join(generated, "cache"), { recursive: true });
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(generated, `generated-untracked-file-${index}.txt`), "");
    }
    await fs.writeFile(path.join(generated, "cache", "rebuildable.txt"), "ignored\n");
    await fs.writeFile(path.join(created.path, "README.md"), "preserve local edit\n");
    now += IDLE_GC_MS + 1;
    const capped = await capUntrackedListing(created.path);
    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-bounded-untracked");
    try {
      expect((await service.gc()).removed).toEqual([created.id]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      const restored = await service.restore({ id: created.id });
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
        "preserve local edit\n",
      );
      const restoredGenerated = path.join(restored.path, "generated", "package");
      expect((await fs.readdir(restoredGenerated)).filter((name) => name !== "cache")).toHaveLength(
        64,
      );
      await expect(fs.stat(path.join(restoredGenerated, "cache"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      warnLogs.cleanup();
      capped.mockRestore();
    }
  });

  it.each([
    ["assume-unchanged", "--assume-unchanged"],
    ["skip-worktree", "--skip-worktree"],
  ])(
    "snapshots untracked children of a directory replacing a %s tracked file",
    async (_label, flag) => {
      await fs.writeFile(path.join(repo, "entry"), "original file\n");
      await git(repo, "add", "entry");
      await git(repo, "commit", "-m", "add tracked parent");
      const created = await materializeRunOwnedFixture(`replaced-${_label}`, "workboard");
      // Git skips its worktree comparison for flagged entries, so neither the collapsed
      // listing nor diff-files reports the directory that replaced this tracked file.
      await git(created.path, "update-index", flag, "entry");
      const parentPath = path.join(created.path, "entry");
      await fs.rm(parentPath);
      await fs.mkdir(parentPath);
      await fs.writeFile(path.join(parentPath, "child.txt"), "discovered child\n");
      now += IDLE_GC_MS + 1;
      const warnLogs = createWarnLogCapture(`openclaw-worktree-gc-replaced-${_label}`);
      try {
        expect((await service.gc()).removed).toEqual([created.id]);
        expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
        const restored = await service.restore({ id: created.id });
        expect(await fs.readFile(path.join(restored.path, "entry", "child.txt"), "utf8")).toBe(
          "discovered child\n",
        );
      } finally {
        warnLogs.cleanup();
      }
    },
  );

  it("detects a nested repository inside a directory replacing a conflicted tracked file", async () => {
    await commitConflictedParent(repo);
    const created = await materializeRunOwnedFixture("replaced-conflicted", "workboard");
    // A modify/delete conflict leaves index stages 1 and 3 without stage 2, which
    // diff-files reports as unmerged rather than deleted, and which keeps the
    // replacement directory out of the collapsed untracked listing.
    await expect(
      execFileAsync("git", ["-C", created.path, "merge", "theirs"]),
    ).rejects.toBeTruthy();
    const parentPath = path.join(created.path, "entry");
    await fs.rm(parentPath, { force: true });
    await fs.mkdir(parentPath);
    const nested = await initializeNestedRepository(created.path, "entry/nested");
    await fs.writeFile(path.join(nested, "local.txt"), "nested state\n");
    now += IDLE_GC_MS + 1;
    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-replaced-conflicted");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe("nested state\n");
    } finally {
      warnLogs.cleanup();
    }
  });

  it("garbage collects a directory replacing a conflicted tracked file and restores it", async () => {
    await commitConflictedParent(repo);
    const created = await materializeRunOwnedFixture("collected-conflicted", "workboard");
    await expect(
      execFileAsync("git", ["-C", created.path, "merge", "theirs"]),
    ).rejects.toBeTruthy();
    // Stages 1 and 3 without stage 2, and no blob in HEAD: the snapshot index has
    // no stage 0 entry Git could drop by name when the path becomes a directory.
    expect(
      (await git(created.path, "ls-files", "--stage", "--", "entry"))
        .split("\n")
        .map((line) => line.split("\t")[0]?.split(" ").at(-1)),
    ).toEqual(["1", "3"]);
    expect(await git(created.path, "ls-tree", "HEAD", "--", "entry")).toBe("");
    const parentPath = path.join(created.path, "entry");
    await fs.rm(parentPath, { force: true });
    await fs.mkdir(parentPath);
    await fs.writeFile(path.join(parentPath, "child.txt"), "replacement\n");
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([created.id]);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "entry", "child.txt"), "utf8")).toBe(
      "replacement\n",
    );
  });

  it("protects a nested repository inside an untracked tree over the Git output cap", async () => {
    const created = await materializeRunOwnedFixture("bounded-nested", "workboard");
    const generated = path.join(created.path, "generated", "package");
    await fs.mkdir(generated, { recursive: true });
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(generated, `generated-untracked-file-${index}.txt`), "");
    }
    const nested = await initializeNestedRepository(created.path, "generated/package/nested");
    await fs.writeFile(path.join(nested, "local.txt"), "nested state\n");
    now += IDLE_GC_MS + 1;
    const capped = await capUntrackedListing(created.path);
    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-bounded-nested");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe("nested state\n");
    } finally {
      warnLogs.cleanup();
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
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(managedWorktreeGcEntrypoint),
          resolveTestNodeExecPath(),
        ),
        String(now),
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

  it("shares one fresh lock inventory across idle and limit prefilters for a repository", async () => {
    const records = [];
    for (let index = 0; index < 3; index++) {
      const record = await materializeRunOwnedFixture(`foreign-lock-${index}`, "session");
      await git(repo, "worktree", "lock", "--reason", "other-tool", record.path);
      records.push(record);
    }
    now += IDLE_GC_MS + 1;
    const inventories = vi.spyOn(worktreeGit, "listGitWorktrees");
    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-lock-inventory");
    try {
      expect((await service.gc({ limits: { maxCount: 1 } })).removed).toEqual([]);
      expect(inventories).toHaveBeenCalledTimes(1);
      for (const record of records) {
        expect(await fs.stat(record.path)).toBeTruthy();
      }
      // A later collection must discover an externally released lock.
      await git(repo, "worktree", "unlock", records[0]!.path);
      expect((await service.gc()).removed).toEqual([records[0]!.id]);
    } finally {
      inventories.mockRestore();
      warnLogs.cleanup();
    }
  });

  it("rechecks a lock acquired after the GC prefilter before removing the checkout", async () => {
    const record = await materializeRunOwnedFixture("late-foreign-lock", "session");
    now += IDLE_GC_MS + 1;
    const readInventory = worktreeGit.listGitWorktrees;
    const inventories = vi
      .spyOn(worktreeGit, "listGitWorktrees")
      .mockImplementationOnce(async (...args) => {
        const entries = await readInventory(...args);
        await git(repo, "worktree", "lock", "--reason", "acquired after inspection", record.path);
        return entries;
      });
    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-late-lock");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect(inventories.mock.calls.length).toBeGreaterThan(1);
      expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      expect(await warnLogs.findText("acquired after inspection")).toBeDefined();
    } finally {
      inventories.mockRestore();
      warnLogs.cleanup();
    }
  });

  it("checks process liveness only for the requested GC candidates", async () => {
    const manual = await materializeDownstreamFixture("unrelated-live-lock");
    const candidate = await materializeRunOwnedFixture("candidate-live-lock", "session");
    await git(repo, "worktree", "lock", "--reason", `openclaw pid=${process.ppid}`, manual.path);
    await git(repo, "worktree", "lock", "--reason", `openclaw pid=${process.pid}`, candidate.path);
    now += IDLE_GC_MS + 1;
    const liveness = vi.spyOn(pidAlive, "isPidDefinitelyDead");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect(liveness).toHaveBeenCalledWith(process.pid);
      expect(liveness).not.toHaveBeenCalledWith(process.ppid);
    } finally {
      liveness.mockRestore();
    }
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
      const result = await service.gc();
      expect(result.removed).toEqual([removable.id]);
      expect(result).toMatchObject({
        outcome: "deferred",
        issues: [
          {
            id: nestedRecord.id,
            stage: "idle",
            outcome: "deferred",
            reason: "worktree contains a nested repository",
          },
        ],
      });
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

  it("reports a failed record once and does not retry it during limit enforcement", async () => {
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
    const result = await service.gc({ limits: { maxCount: 0 } });

    expect(result.removed).toEqual([removable.id]);
    expect(result).toMatchObject({
      outcome: "partial",
      issueCount: 1,
      issues: [
        {
          id: broken.id,
          stage: "idle",
          outcome: "failed",
          reason: expect.stringContaining("cleanup-failed"),
        },
      ],
      limitsSatisfied: false,
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
      expect(result.limitsSatisfied).toBeNull();
      expect(getRegistryWorktree(env, unreadable.id)?.removedAt).toBeUndefined();
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("reports false when the count cap is exceeded despite unknown current size", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const unreadable = await materializeDownstreamFixture("manual-size-unreadable");
    const locked = path.join(unreadable.path, "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    try {
      const result = await service.gc({ limits: { maxCount: 0, maxTotalSizeBytes: 6_000 } });
      expect(result.limitsSatisfied).toBe(false);
      expect(result.removed).toEqual([]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("reports unknown size compliance for worktrees created during enforcement", async () => {
    const oversized = await materializeRunOwnedFixture("size-race-oldest", "session");
    await fs.writeFile(path.join(oversized.path, "blob.bin"), Buffer.alloc(10_000));
    let concurrentId = "";
    const realRemove = service.remove.bind(service);
    vi.spyOn(service, "remove").mockImplementationOnce(async (params) => {
      const concurrent = await materializeRunOwnedFixture("size-race-created", "session");
      concurrentId = concurrent.id;
      return await realRemove(params);
    });

    const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });

    expect(result.limitsSatisfied).toBeNull();
    expect(result.issues).toContainEqual({
      id: concurrentId,
      stage: "limits",
      outcome: "deferred",
      reason: "created during cleanup; run cleanup again",
    });
  });

  it("refreshes a below-limit inventory before reporting compliance", async () => {
    await materializeRunOwnedFixture("size-race-within-limit", "session");
    let concurrentId = "";
    const readSize = worktreeCapacity.directorySizeBytes;
    const directorySize = vi
      .spyOn(worktreeCapacity, "directorySizeBytes")
      .mockImplementationOnce(async (worktreePath) => {
        const bytes = await readSize(worktreePath);
        const concurrent = await materializeRunOwnedFixture("size-race-cap-breach", "session");
        concurrentId = concurrent.id;
        return bytes;
      });
    try {
      const result = await service.gc({
        limits: { maxCount: 2, maxTotalSizeBytes: 1024 ** 3 },
      });
      expect(result.limitsSatisfied).toBeNull();
      expect(result.outcome).toBe("deferred");
      expect(result.issues).toContainEqual({
        id: concurrentId,
        stage: "limits",
        outcome: "deferred",
        reason: "created during cleanup; run cleanup again",
      });
    } finally {
      directorySize.mockRestore();
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
        throw new Error("removal already claimed");
      });

    const result = await service.gc({ limits: { maxCount: 2 } });

    // The stale-count correction stops the pass at two live worktrees instead
    // of evicting middle as well.
    expect(result.removed).toEqual([]);
    expect(getRegistryWorktree(env, oldest.id)?.removedAt).toBeDefined();
    expect(getRegistryWorktree(env, middle.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    removeSpy.mockRestore();
  });

  it.each(["idle", "limit"])(
    "preserves a worktree used after the %s cleanup inspection",
    async (kind) => {
      const created = await materializeRunOwnedFixture("resumed", "session", "agent:main:resumed");
      now += kind === "idle" ? IDLE_GC_MS + 1 : 1;
      const remove = service.remove.bind(service);
      const resumed = vi.spyOn(service, "remove").mockImplementationOnce(async (params) => {
        await service.acquire(created.id);
        await service.release(created.id);
        return await remove(params);
      });
      try {
        const result = await service.gc({
          limits: kind === "limit" ? { maxCount: 0 } : {},
        });
        expect(result.removed).toEqual([]);
        expect(getRegistryWorktree(env, created.id)).toMatchObject({ lastActiveAt: now });
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      } finally {
        resumed.mockRestore();
      }
    },
  );

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
      (await service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
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

  it("checks owner retirement only for live worktrees while retaining fresh snapshots", async () => {
    const removed = await materializeRunOwnedFixture(
      "removed-owner",
      "session",
      "agent:main:removed",
    );
    const snapshot = await service.remove({ id: removed.id, reason: "test-retention" });
    const snapshotCommit = await git(repo, "rev-parse", snapshot.snapshotRef!);
    const live = await materializeRunOwnedFixture("live-owner", "session", "agent:main:live");
    const shouldRemoveOwner = vi.fn(() => false);

    const result = await service.gc({ shouldRemoveOwner });

    expect(shouldRemoveOwner.mock.calls).toEqual([["session", live.ownerId]]);
    expect(result.removed).toEqual([]);
    expect(result.snapshotsPruned).toBe(0);
    expect(getRegistryWorktree(env, removed.id)).toMatchObject({
      removedAt: now,
      snapshotRef: snapshot.snapshotRef,
    });
    expect(await git(repo, "rev-parse", snapshot.snapshotRef!)).toBe(snapshotCommit);
    expect(getRegistryWorktree(env, live.id)?.removedAt).toBeUndefined();
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

  it("does not restore a snapshot while garbage collection is expiring it", async () => {
    const disk = fsSync.statfsSync(root);
    const diskSpace = vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      type: disk.type,
      files: disk.files,
      frsize: disk.frsize,
      ffree: disk.ffree,
      bsize: 4096,
      blocks: 1024 ** 4 / 4096,
      bavail: (100 * 1024 ** 3) / 4096,
      bfree: (100 * 1024 ** 3) / 4096,
    });
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const created = await materializeDownstreamFixture("restoring-expired");
    await fs.writeFile(path.join(created.path, "README.md"), "saved edit\n");
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;
    const deleting = createDeferred();
    const resume = createDeferred();
    const realGit = worktreeGit.requireGit;
    const blockedDeletion = vi
      .spyOn(worktreeGit, "requireGit")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "update-ref" && args[1] === "-d" && args[2] === removed.snapshotRef) {
          deleting.resolve();
          await resume.promise;
        }
        return await realGit(cwd, args, options);
      });
    const collection = service.gc();
    let restoration: ReturnType<typeof service.restore> | undefined;
    const waits = vi.spyOn(backoff, "sleepWithAbort");
    try {
      await Promise.race([
        deleting.promise,
        collection.then((result) => {
          throw new Error(`Collection did not reach snapshot expiry: ${JSON.stringify(result)}`);
        }),
      ]);
      let settled = false;
      restoration = service.restore({ id: created.id });
      const outcome = restoration
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(waits.mock.calls.length > 0 || settled).toBe(true));
      resume.resolve();
      expect((await collection).snapshotsPruned).toBe(1);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("not restorable"),
      });
      expect(getRegistryWorktree(env, created.id)).toBeUndefined();
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
    } finally {
      resume.resolve();
      await Promise.allSettled([restoration, collection]);
      blockedDeletion.mockRestore();
      waits.mockRestore();
      diskSpace.mockRestore();
    }
  });
});
