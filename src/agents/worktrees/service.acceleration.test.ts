import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backoff from "../../infra/backoff.js";
import * as gitExec from "../../infra/git-exec.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import * as commandExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import * as capacity from "./capacity.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates, reserveTemplate, touchTemplate } from "./template-registry.js";

vi.mock("./filesystem-backend.js", () => ({
  detectWorktreeFilesystemBackend: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("ManagedWorktreeService filesystem acceleration", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let acceleration: boolean | undefined;
  let service: ManagedWorktreeService;
  let backend: WorktreeFilesystemBackend;

  beforeEach(async () => {
    // Hosted runners can install system-wide LFS filters, which intentionally
    // disable acceleration. Each case owns its checkout policy instead.
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-worktree-acceleration-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = Date.now();
    acceleration = undefined;
    // Real Git and the production lifecycle run on every host; only native
    // subvolume operations are replaced with independent directory copies.
    backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: acceleration }),
    });
  });

  it.each([
    "warm",
    "small",
    "restore",
    "remote-restore",
    "cold",
    "disabled",
    "invalid",
    "fallback",
  ])("admits only reusable source clones under disk pressure (%s)", async (mode) => {
    const sourceBytes = mode === "small" ? 32 * 1024 : 32 * 1024 ** 2;
    await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(sourceBytes, 7));
    await git(repo, "add", "large.bin");
    await git(repo, "commit", "-m", "large source");
    const restores = mode === "restore" || mode === "remote-restore";
    if (mode === "remote-restore") {
      await git(repo, "push", "origin", "main");
    }
    let restoreId: string | undefined;
    if (mode !== "cold") {
      const seed = await service.create({
        repoRoot: repo,
        name: "seed",
        baseRef: mode === "remote-restore" ? "origin/main" : "HEAD",
      });
      if (mode === "remote-restore") {
        expect(await git(repo, "config", "--get", `branch.${seed.branch}.remote`)).toBe("origin");
      }
      if (restores) {
        await fs.writeFile(path.join(seed.path, "README.md"), "saved work\n");
        await service.remove({ id: seed.id, reason: "archive" });
        restoreId = seed.id;
        if (mode === "remote-restore") {
          await expect(
            git(repo, "config", "--get", `branch.${seed.branch}.remote`),
          ).rejects.toThrow();
        }
      }
    }
    if (mode === "disabled") {
      acceleration = false;
    }
    if (mode === "invalid") {
      await fs.writeFile(path.join(listTemplates(env)[0]!.path, "README.md"), "changed template");
    }
    if (mode === "fallback") {
      vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("clone unavailable"));
    }
    const available = 16 * 1024 ** 3 + (mode === "small" ? 1 : 24) * 1024 ** 2;
    const stats = fsSync.statfsSync(repo);
    vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      type: stats.type,
      files: stats.files,
      ffree: stats.ffree,
      frsize: stats.frsize,
      bsize: 4096,
      blocks: 1024 ** 4 / 4096,
      bavail: available / 4096,
      bfree: available / 4096,
    });
    const result = restoreId
      ? service.restore({ id: restoreId })
      : service.create({ repoRoot: repo, name: "limited", baseRef: "HEAD" });
    if (mode === "warm" || restores || mode === "small") {
      const created = await result;
      expect((await fs.stat(path.join(created.path, "large.bin"))).size).toBe(sourceBytes);
      if (mode === "small") {
        expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
      }
      if (restores) {
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
          "saved work\n",
        );
        expect(await git(created.path, "status", "--porcelain")).toBe("M README.md");
        expect(await git(created.path, "rev-parse", "HEAD")).toBe(
          await git(repo, "rev-parse", "HEAD"),
        );
      } else {
        expect(await git(created.path, "status", "--porcelain")).toBe("");
      }
    } else {
      await expect(result).rejects.toThrow(/disk space/i);
      if (mode === "fallback") {
        expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
      }
      expect(await git(repo, "branch", "--list", "openclaw/limited")).toBe("");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("/limited");
      expect(
        (await service.listRegistryRecords()).some(
          (record) => record.branch === "openclaw/limited",
        ),
      ).toBe(false);
    }
  });

  it.each(["cold", "warm"])(
    "admits the registered commit before preparing a %s template and pins fallback to it",
    async (cache) => {
      const initial = await git(repo, "rev-parse", "HEAD");
      const sourceBytes = 32 * 1024 ** 2;
      await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(sourceBytes, 7));
      await git(repo, "add", "large.bin");
      await git(repo, "commit", "-m", "larger checkout source");
      const larger = await git(repo, "rev-parse", "HEAD");
      await git(repo, "checkout", "--detach", initial);
      const sourceRef = "refs/remotes/origin/racing";
      await git(repo, "update-ref", sourceRef, initial);
      if (cache === "warm") {
        await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
      }
      const before = await service.listRegistryRecords();
      const stats = fsSync.statfsSync(repo);
      let available = 16 * 1024 ** 3 + 24 * 1024 ** 2;
      vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
        type: stats.type,
        files: stats.files,
        ffree: stats.ffree,
        frsize: stats.frsize,
        bsize: 4096,
        blocks: 1024 ** 4 / 4096,
        bavail: available / 4096,
        bfree: available / 4096,
      }));
      let advanced = false;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (
          !advanced &&
          argv[0] === "git" &&
          argv.includes("worktree") &&
          argv.includes("add") &&
          argv.at(-1) === "origin/racing"
        ) {
          await git(repo, "update-ref", sourceRef, larger, initial);
          advanced = true;
        }
        return await realRunCommand(argv, options);
      });
      const params = { repoRoot: repo, name: "racing", baseRef: "origin/racing" };
      await expect(service.create(params)).rejects.toThrow(/disk space/i);
      expect(advanced).toBe(true);
      expect(await service.listRegistryRecords()).toEqual(before);
      expect(await git(repo, "branch", "--list", "openclaw/racing")).toBe("");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("/racing");
      for (const template of listTemplates(env)) {
        await expect(fs.access(path.join(template.path, "large.bin"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      available = 16 * 1024 ** 3 + 96 * 1024 ** 2;
      vi.mocked(backend.cloneTemplate).mockImplementationOnce(async () => {
        await git(repo, "update-ref", sourceRef, initial, larger);
        throw new Error("clone unavailable after the source ref moved");
      });
      const created = await service.create(params);
      expect(await git(repo, "rev-parse", sourceRef)).toBe(initial);
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(larger);
      expect((await fs.stat(path.join(created.path, "large.bin"))).size).toBe(sourceBytes);
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(
        await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
      ).toBe("origin/racing");
    },
  );

  it("reuses clean source while including current ignored files and running setup for each checkout", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nprivate.txt\nsetup-ran.txt\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure provisioning");
    await fs.writeFile(path.join(repo, "README.md"), "uncommitted source edit\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked source\n");
    await fs.writeFile(path.join(repo, "private.txt"), "ignored source\n");
    await fs.writeFile(path.join(repo, ".env.local"), "first\n");
    if (process.platform !== "win32") {
      await fs.mkdir(path.join(repo, ".openclaw"));
      await fs.writeFile(
        path.join(repo, ".openclaw", "worktree-setup.sh"),
        '#!/bin/sh\nprintf "%s" "$OPENCLAW_WORKTREE_PATH" > setup-ran.txt\n',
        { mode: 0o755 },
      );
    }

    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    expect(template?.status).toBe("ready");
    await fs.writeFile(path.join(repo, ".env.local"), "second\n");
    await fs.writeFile(path.join(first.path, "README.md"), "first checkout edit\n");
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });

    expect(backend.createTemplate).toHaveBeenCalledTimes(1);
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe(
      "first checkout edit\n",
    );
    expect(await fs.readFile(path.join(first.path, ".env.local"), "utf8")).toBe("first\n");
    expect(await fs.readFile(path.join(second.path, ".env.local"), "utf8")).toBe("second\n");
    for (const name of ["untracked.txt", "private.txt"]) {
      await expect(fs.access(path.join(second.path, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const name of [".env.local", "setup-ran.txt"]) {
      await expect(fs.access(path.join(template.path, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    if (process.platform !== "win32") {
      for (const record of [first, second]) {
        expect(await fs.readFile(path.join(record.path, "setup-ran.txt"), "utf8")).toBe(
          record.path,
        );
      }
    }
    expect(await git(second.path, "status", "--porcelain")).toBe("");
    expect(await git(second.path, "symbolic-ref", "--short", "HEAD")).toBe(second.branch);
    await git(second.path, "checkout", "HEAD~1");
    await expect(fs.access(path.join(second.path, ".worktreeinclude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["tracked", "staged", "untracked", "ignored", "renamed", "HEAD"] as const)(
    "rebuilds a template with %s contamination before creating another checkout",
    async (change) => {
      await fs.writeFile(path.join(repo, ".gitignore"), "ignored-*\n");
      await git(repo, "add", ".gitignore");
      await git(repo, "commit", "-m", "ignore template fixture");
      // The older commit has identical files, so HEAD validation cannot be
      // replaced by comparing the tree or accepting a clean inventory alone.
      await git(repo, "commit", "--allow-empty", "-m", "new template base");
      await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
      const original = listTemplates(env)[0];
      assert(original);
      const unusualName = process.platform === "win32" ? "é space.txt" : "é space\nname.txt";
      if (change === "HEAD") {
        await git(original.path, "checkout", "--detach", "HEAD~1");
      } else if (change === "renamed") {
        await git(original.path, "mv", "README.md", unusualName);
      } else if (change === "tracked" || change === "staged") {
        await fs.writeFile(path.join(original.path, "README.md"), "template contamination\n");
        if (change === "staged") {
          await git(original.path, "add", "README.md");
        }
      } else {
        await fs.writeFile(
          path.join(original.path, `${change === "ignored" ? "ignored-" : ""}${unusualName}`),
          "template contamination\n",
        );
      }

      const created = await service.create({
        repoRoot: repo,
        name: "replacement",
        baseRef: "HEAD",
      });

      const replacement = listTemplates(env)[0];
      assert(replacement);
      expect(replacement.id).not.toBe(original.id);
      await expect(fs.access(original.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(created.path)).toSorted()).toEqual([
        ".git",
        ".gitignore",
        "README.md",
      ]);
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(original.sourceCommit);
      expect(
        await git(created.path, "status", "--porcelain", "--untracked-files=all", "--ignored"),
      ).toBe("");
    },
  );

  it("accelerates with spaces, Unicode and supported newlines in Git metadata paths", async () => {
    const unusualName = process.platform === "win32" ? "é space" : "é space\nline";
    const movedRepo = path.join(path.dirname(repo), unusualName);
    await fs.rename(repo, movedRepo);
    repo = await fs.realpath(movedRepo);
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({
        worktreeRoot: path.join(path.dirname(repo), `${unusualName}-worktrees`),
      }),
    });
    const commands = vi.spyOn(commandExec, "runCommandWithTimeout");

    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });

    expect(backend.createTemplate).toHaveBeenCalledTimes(1);
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    // A malformed metadata path must not silently discard the completed clone
    // and pay for a second, ordinary checkout.
    expect(commands.mock.calls.some(([args]) => args.includes("reset"))).toBe(false);
    for (const record of [first, second]) {
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
    }
  });

  it("honors the opt-out without probing a filesystem backend", async () => {
    acceleration = false;
    const created = await service.create({ repoRoot: repo, name: "native", baseRef: "HEAD" });
    expect(detectWorktreeFilesystemBackend).not.toHaveBeenCalled();
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it("uses native Git when the repository configures a checkout filter", async () => {
    await git(repo, "config", "filter.fixture.required", "true");
    const created = await service.create({ repoRoot: repo, name: "filtered", baseRef: "HEAD" });

    expect(backend.createTemplate).not.toHaveBeenCalled();
    expect(backend.cloneTemplate).not.toHaveBeenCalled();
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await git(created.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
  });

  it("replaces stale source and expires its template without removing live manual worktrees", async () => {
    const first = await service.create({ repoRoot: repo, name: "old", baseRef: "HEAD" });
    const original = listTemplates(env)[0];
    assert(original);
    await fs.writeFile(path.join(repo, "README.md"), "new commit\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "change source");
    const second = await service.create({ repoRoot: repo, name: "new", baseRef: "HEAD" });
    const templates = listTemplates(env);
    expect(templates).toHaveLength(1);
    const replacement = templates[0];
    assert(replacement);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
    await expect(fs.access(original.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("new commit\n");

    now += IDLE_GC_MS + 1;
    expect((await service.gc()).removed).toEqual([]);
    expect(listTemplates(env)).toEqual([]);
    await expect(fs.access(replacement.path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const record of [first, second]) {
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
    }
  });

  it("cleans a partial snapshot and completes creation through native Git", async () => {
    vi.mocked(backend.cloneTemplate).mockImplementationOnce(async (_source, destination) => {
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "partial.txt"), "incomplete snapshot\n");
      throw new Error("filesystem snapshot failed");
    });
    const created = await service.create({ repoRoot: repo, name: "fallback", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    await expect(fs.access(path.join(created.path, "partial.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await git(created.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
    expect((await service.list()).map((entry) => entry.id)).toEqual([created.id]);
  });

  it.each(["advanced", "detached", "redirected"])(
    "preserves files when clone fallback finds a %s worktree HEAD",
    async (change) => {
      const initial = await git(repo, "rev-parse", "HEAD");
      const later = await git(repo, "commit-tree", "HEAD^{tree}", "-p", initial, "-m", "later");
      await git(repo, "branch", "other-owner", initial);
      const branch = "openclaw/guarded-fallback";
      let registration = "";
      let destination = "";
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await realRunCommand(argv, options);
        if (
          argv[0] === "git" &&
          argv.includes("worktree") &&
          argv.includes("add") &&
          argv.includes(branch) &&
          result.code === 0
        ) {
          destination = argv.at(-2)!;
          registration = await git(destination, "rev-parse", "--absolute-git-dir");
        }
        return result;
      });
      vi.mocked(backend.cloneTemplate).mockImplementationOnce(async (source, target) => {
        assert(registration);
        await fs.cp(source, target, { recursive: true, verbatimSymlinks: true });
        await fs.writeFile(path.join(target, "sentinel.txt"), "new owner's files\n");
        if (change === "advanced") {
          await git(repo, "update-ref", `refs/heads/${branch}`, later, initial);
        } else if (change === "detached") {
          await git(repo, "--git-dir", registration, "update-ref", "--no-deref", "HEAD", initial);
        } else {
          await git(
            repo,
            "--git-dir",
            registration,
            "symbolic-ref",
            "HEAD",
            "refs/heads/other-owner",
          );
        }
        // The copied .git still points at the template when cloning fails.
        throw new Error("clone failed after worktree ownership changed");
      });

      await expect(
        service.create({ repoRoot: repo, name: "guarded-fallback", baseRef: "HEAD" }),
      ).rejects.toThrow(/changed|preserve/i);
      expect(await fs.readFile(path.join(destination, "sentinel.txt"), "utf8")).toBe(
        "new owner's files\n",
      );
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(destination);
      expect(await git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(
        change === "advanced" ? later : initial,
      );
      const symbolic = git(repo, "--git-dir", registration, "symbolic-ref", "HEAD");
      if (change === "detached") {
        await expect(symbolic).rejects.toThrow();
      } else {
        expect(await symbolic).toBe(
          change === "redirected" ? "refs/heads/other-owner" : `refs/heads/${branch}`,
        );
      }
      expect(await service.listRegistryRecords()).toEqual([]);
    },
  );

  it("preserves an in-progress clone while garbage collection waits for allocation", async () => {
    acceleration = false;
    const existing = await service.create({ repoRoot: repo, name: "existing", baseRef: "HEAD" });
    acceleration = true;
    const inventoryStarted = createDeferredCore();
    const finishInventory = createDeferredCore();
    const readSize = capacity.directorySizeBytes;
    vi.spyOn(capacity, "directorySizeBytes").mockImplementation(async (...args) => {
      if (args[0] === existing.path) {
        inventoryStarted.resolve();
        await finishInventory.promise;
      }
      return await readSize(...args);
    });
    const cloneStarted = createDeferredCore<string>();
    const finishClone = createDeferredCore();
    vi.mocked(backend.cloneTemplate).mockImplementationOnce(
      async (source, destination, options) => {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "partial.txt"), "in-progress clone\n");
        cloneStarted.resolve(destination);
        await finishClone.promise;
        options.commitGuard();
        await fs.unlink(path.join(destination, "partial.txt"));
        await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
      },
    );
    const collection = service.gc({
      limits: { maxTotalSizeBytes: Number.MAX_SAFE_INTEGER },
    });
    let creation: ReturnType<typeof service.create> | undefined;
    try {
      await Promise.race([
        inventoryStarted.promise,
        collection.then(() => {
          throw new Error("Collection completed without inventorying the existing checkout");
        }),
      ]);
      creation = service.create({ repoRoot: repo, name: "allocating", baseRef: "HEAD" });
      const destination = await Promise.race([
        cloneStarted.promise,
        creation.then(() => {
          throw new Error("Creation completed without starting a clone");
        }),
      ]);
      const contended = createDeferredCore();
      const sleep = backoff.sleepWithAbort;
      vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (...args) => {
        contended.resolve();
        return await sleep(...args);
      });
      finishInventory.resolve();
      await Promise.race([contended.promise, collection]);
      expect(await fs.readFile(path.join(destination, "partial.txt"), "utf8")).toBe(
        "in-progress clone\n",
      );
    } finally {
      finishInventory.resolve();
      finishClone.resolve();
      await Promise.all([creation, collection]);
    }
    assert(creation);
    const created = await creation;
    expect((await collection).orphansDeleted).toBe(0);
    expect((await service.listRegistryRecords()).map((record) => record.id).toSorted()).toEqual(
      [existing.id, created.id].toSorted(),
    );
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it.each([false, true])(
    "retains expired snapshots until allocation cleanup can run with acceleration %s",
    async (enabled) => {
      acceleration = enabled;
      const created = await service.create({ repoRoot: repo, name: "expired", baseRef: "HEAD" });
      const removed = await service.remove({ id: created.id, reason: "retention" });
      now += SNAPSHOT_RETENTION_MS + 1;
      const allocation = vi
        .spyOn(stateLease, "withOpenClawStateLease")
        .mockRejectedValue(new Error("allocation lease unavailable"));

      expect((await service.gc()).snapshotsPruned).toBe(0);
      expect(await service.listRegistryRecords()).toEqual([
        expect.objectContaining({ id: created.id, snapshotRef: removed.snapshotRef }),
      ]);
      expect(await git(repo, "rev-parse", removed.snapshotRef!)).toMatch(/^[a-f0-9]+$/u);
      expect(listTemplates(env)).toHaveLength(enabled ? 1 : 0);
      allocation.mockRestore();

      expect((await service.gc()).snapshotsPruned).toBe(1);
      expect(await service.listRegistryRecords()).toEqual([]);
      await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
      expect(listTemplates(env)).toEqual([]);
    },
  );

  it("rereads template activity after waiting for the allocation lease", async () => {
    await service.create({ repoRoot: repo, name: "retained", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    now += IDLE_GC_MS + 1;
    const held = createDeferredCore<stateLease.OpenClawStateLeaseContext>();
    const release = createDeferredCore();
    const holder = stateLease.withOpenClawStateLease(
      {
        scope: "core:managed-worktrees:create",
        key: "capacity",
        database: { scope: "shared", options: { env } },
        leaseMs: 60_000,
        waitMs: 0,
      },
      async (lease) => {
        held.resolve(lease);
        await release.promise;
      },
    );
    const lease = await held.promise;
    const allocation = vi.spyOn(stateLease, "withOpenClawStateLease");
    const pending = service.gc();
    try {
      await vi.waitFor(() => expect(allocation).toHaveBeenCalledTimes(1));
      expect(touchTemplate(env, template.id, now, () => lease.assertOwned())).toBe(true);
    } finally {
      release.resolve();
      await holder;
    }
    expect((await pending).removed).toEqual([]);
    expect(listTemplates(env)).toEqual([{ ...template, lastUsedAt: now }]);
    expect(await fs.readFile(path.join(template.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("validates every template before retirement and releases the lease after invalid status", async () => {
    await service.create({ repoRoot: repo, name: "preserved", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    const invalid = {
      ...template,
      cacheKey: "invalid-template",
      id: "invalid-template",
      path: path.join(path.dirname(template.path), "invalid-template"),
      status: "preparing" as const,
      lastUsedAt: template.lastUsedAt + 1,
    };
    reserveTemplate(env, invalid, () => {});
    await fs.mkdir(invalid.path);
    await fs.writeFile(path.join(invalid.path, "preserved.txt"), "preserve invalid template\n");
    const { db } = openOpenClawStateDatabase({ env });
    // Model a damaged row that bypassed the table's status CHECK constraint.
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      db.prepare("UPDATE worktree_templates SET status = 'invalid' WHERE id = ?").run(invalid.id);
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }
    now += IDLE_GC_MS + 1;
    const warnings = createWarnLogCapture("openclaw-worktree-invalid-template");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnings.findText("worktree template cleanup deferred:")).toBe(
        "worktree template cleanup deferred: Error: Invalid worktree template status: invalid",
      );
      expect(await fs.readFile(path.join(template.path, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.readFile(path.join(invalid.path, "preserved.txt"), "utf8")).toBe(
        "preserve invalid template\n",
      );
      expect(db.prepare("SELECT id FROM worktree_templates").all()).toHaveLength(2);
      await expect(
        stateLease.withOpenClawStateLease(
          {
            scope: "core:managed-worktrees:create",
            key: "capacity",
            database: { scope: "shared", options: { env } },
            leaseMs: 60_000,
            waitMs: 0,
          },
          async (lease) => {
            lease.assertOwned();
            return "released";
          },
        ),
      ).resolves.toBe("released");
    } finally {
      warnings.cleanup();
    }
  });

  it.each(["current", "revoked"] as const)(
    "handles %s allocation authority when snapshot and native fallback both fail",
    async (authority) => {
      vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("snapshot unavailable"));
      let failedDestination: string | undefined;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (argv[0] === "git" && argv.includes("read-tree") && argv.includes("-u")) {
          failedDestination = argv[argv.indexOf("-C") + 1];
          return {
            stdout: "",
            stderr: "native checkout failed",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return await realRunCommand(argv, options);
      });

      const branch = "openclaw/failed-fallback";
      const originalHead = await git(repo, "rev-parse", "HEAD");
      const commonDir = await git(repo, "rev-parse", "--git-common-dir");
      const held = createDeferredCore();
      const release = createDeferredCore();
      const holder = gitExec.enqueueGitRefMutation(repo, commonDir, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const queueCalls = vi.spyOn(gitExec, "enqueueGitRefMutation");
      const pending = service
        .create({
          repoRoot: repo,
          name: "failed-fallback",
          baseRef: "HEAD",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        await Promise.race([
          vi.waitFor(() => expect(queueCalls.mock.calls.length).toBe(1), { timeout: 10_000 }),
          pending.then(() => {
            throw new Error("Checkout ended before cleanup queued its branch deletion");
          }),
        ]);
        expect(failedDestination).toBeDefined();
        expect(await git(repo, "rev-parse", branch)).toBe(originalHead);
        await expect(fs.access(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
        if (authority === "revoked") {
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              const changed = executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
                  .updateTable("state_leases")
                  .set({ owner: "successor" })
                  .where("scope", "=", "core:managed-worktrees:create")
                  .where("lease_key", "=", "capacity"),
              );
              expect(changed.numAffectedRows).toBe(1n);
            },
            { env },
          );
        }
        release.resolve();
        await holder;
        const error = await pending;
        if (authority === "revoked") {
          expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
          expect(await git(repo, "branch", "--list", branch)).toBe(branch);
          expect(await git(repo, "rev-parse", branch)).toBe(originalHead);
        } else {
          expect(error).toBeInstanceOf(Error);
          expect(error instanceof Error && error.message.includes("native checkout failed")).toBe(
            true,
          );
          expect(await git(repo, "branch", "--list", branch)).toBe("");
        }
        expect(failedDestination).toBeDefined();
        expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("failed-fallback");
        expect(await service.listRegistryRecords()).toEqual([]);
        await expect(fs.access(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release.resolve();
        await holder;
        await pending;
      }
    },
  );

  it.each(["repository", "metadata"])(
    "expires an owned template after its %s disappears while preserving live worktree data",
    async (missing) => {
      const created = await service.create({ repoRoot: repo, name: "preserved", baseRef: "HEAD" });
      const template = listTemplates(env)[0];
      assert(template);
      await fs.writeFile(path.join(created.path, "README.md"), "irreplaceable worktree edit\n");
      const source = missing === "repository" ? repo : path.join(repo, ".git");
      await fs.rename(source, `${source}-moved`);
      now += IDLE_GC_MS + 1;

      expect((await service.gc()).removed).toEqual([]);
      expect(listTemplates(env)).toEqual([]);
      await expect(fs.access(template.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
        "irreplaceable worktree edit\n",
      );
      expect(await service.listRegistryRecords()).toEqual([
        expect.objectContaining({ id: created.id }),
      ]);
      expect((await service.listRegistryRecords())[0]?.removedAt).toBeUndefined();
    },
  );

  it.each([false, true])(
    "restores saved edits and retains the source template (clone failure=%s)",
    async (cloneFails) => {
      const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
      const template = listTemplates(env)[0];
      assert(template);
      const originalCommit = await git(created.path, "rev-parse", "HEAD");
      await fs.writeFile(path.join(created.path, "README.md"), "saved edit\n");
      await fs.writeFile(path.join(created.path, "untracked.txt"), "saved new file\n");
      await service.remove({ id: created.id, reason: "test" });
      if (cloneFails) {
        vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("clone unavailable"));
      }
      const restored = await service.restore({ id: created.id });
      expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
      expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalCommit);
      expect(await git(restored.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
      expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
        "saved new file\n",
      );
      expect(await git(restored.path, "status", "--porcelain")).toContain("M README.md");
      expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
      expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.readFile(path.join(template.path, "README.md"), "utf8")).toBe("base\n");
      await expect(fs.access(path.join(template.path, "untracked.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const next = await service.create({ repoRoot: repo, name: "after-restore", baseRef: "HEAD" });
      expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
      expect(await git(next.path, "status", "--porcelain")).toBe("");
    },
  );

  it("applies saved checkout attributes to unchanged blobs without replacing the source template", async () => {
    await git(repo, "config", "core.autocrlf", "false");
    const created = await service.create({
      repoRoot: repo,
      name: "restore-attributes",
      baseRef: "HEAD",
    });
    const template = listTemplates(env)[0];
    assert(template);
    await fs.writeFile(path.join(created.path, ".gitattributes"), "*.md text eol=crlf\n");
    await service.remove({ id: created.id, reason: "test" });

    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\r\n");
    expect(await git(restored.path, "status", "--porcelain")).toBe("?? .gitattributes");
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    expect(await fs.readFile(path.join(template.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("restores without checking out a removed file whose old filter is unavailable", async () => {
    acceleration = false;
    await fs.writeFile(path.join(repo, ".gitattributes"), "removed.txt filter=unavailable\n");
    await fs.writeFile(path.join(repo, "removed.txt"), "original file\n");
    await git(repo, "add", ".gitattributes", "removed.txt");
    await git(repo, "commit", "-m", "add filtered source");
    const created = await service.create({
      repoRoot: repo,
      name: "removed-filter",
      baseRef: "HEAD",
    });
    await fs.unlink(path.join(created.path, "removed.txt"));
    await service.remove({ id: created.id, reason: "test" });
    await git(repo, "config", "filter.unavailable.required", "true");
    await git(repo, "config", "filter.unavailable.smudge", "openclaw-missing-smudge-command");

    const restored = await service.restore({ id: created.id });

    await expect(fs.access(path.join(restored.path, "removed.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "HEAD"),
    );
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
  });

  it("keeps the snapshot retryable when cancellation follows materializing saved edits", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "cancel-restore",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "saved edit\n");
    const removed = await service.remove({ id: created.id, reason: "test" });
    const snapshot = await git(repo, "rev-parse", removed.snapshotRef!);
    const controller = new AbortController();
    const cancelled = new Error("restore cancelled");
    const commands = vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const result = await realRunCommand(argv, options);
        if (argv[0] === "git" && argv.includes("read-tree") && argv.includes("-u")) {
          expect(result.code).toBe(0);
          controller.abort(cancelled);
        }
        return result;
      });

    await expect(
      service.restore({ id: created.id, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_ABORTED",
      cause: cancelled,
    });
    commands.mockRestore();
    expect(await git(repo, "rev-parse", removed.snapshotRef!)).toBe(snapshot);
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    await expect(fs.access(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.listRegistryRecords())[0]?.removedAt).toBeDefined();
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await git(restored.path, "status", "--porcelain")).toBe("M README.md");
  });

  it("uses current external Git attributes instead of reusing a cached checkout", async () => {
    await git(repo, "config", "core.autocrlf", "false");
    const first = await service.create({ repoRoot: repo, name: "before-attrs", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    const configHome = path.join(path.dirname(repo), "git-config-home");
    await fs.mkdir(path.join(configHome, "git"), { recursive: true });
    await fs.writeFile(path.join(configHome, "git", "attributes"), "*.md text eol=crlf\n");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const second = await service.create({ repoRoot: repo, name: "after-attrs", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\r\n");
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
  });
});
