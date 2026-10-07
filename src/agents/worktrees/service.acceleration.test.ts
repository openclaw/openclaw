import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeTreeClone, readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as gitExec from "../../infra/git-exec.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as commandRunner from "../../process/exec-runner.js";
import * as commandExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { addManagedWorktree } from "./checkout.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import {
  listTemplatesAsync,
  markTemplateReadyAsync,
  releaseTemplateReaderAsync,
  retainTemplateReaderAsync,
} from "./template-registry-async.js";

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
    useInProcessWorktreeCapacityTransport();
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

  it("reclaims dead creation custody before concurrent creates after restart", async () => {
    await service.create({ repoRoot: repo, name: "warm", baseRef: "HEAD" });
    const failure = new CommandProcessCleanupError();
    vi.mocked(backend.cloneTemplate).mockRejectedValue(failure);
    const crashed = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) =>
        service.create({
          repoRoot: repo,
          name: `crashed-${index}`,
          baseRef: "HEAD",
          ownerKind: "session",
          ownerId: `agent:main:crashed-${index}`,
        }),
      ),
    );
    expect(crashed.every((result) => result.status === "rejected")).toBe(true);
    expect(await readPendingWorktrees(env)).toHaveLength(3);
    const template = (await listTemplatesAsync(env))[0]!;
    // Persist the crash boundary with the real owner's rows, then restart its database lifetime.
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const k = getNodeSqliteKysely<Pick<DB, "state_leases" | "worktree_templates">>(db);
        const rows = executeSqliteQuerySync(
          db,
          k
            .selectFrom("state_leases")
            .selectAll()
            .where("scope", "like", "core:managed-worktrees:%"),
        ).rows;
        for (const row of rows) {
          executeSqliteQuerySync(
            db,
            k
              .updateTable("state_leases")
              .set({
                expires_at: row.expires_at === null ? null : 0,
                payload_json: JSON.stringify({
                  ...JSON.parse(row.payload_json ?? "{}"),
                  owner: { pid: 2147483647, host: hostname(), startedAt: null },
                }),
              })
              .where("scope", "=", row.scope)
              .where("lease_key", "=", row.lease_key),
          );
        }
        executeSqliteQuerySync(
          db,
          k
            .updateTable("worktree_templates")
            .set({ status: "preparing" })
            .where("id", "=", template.id),
        );
      },
      { env },
    );
    await closeOpenClawStateDatabaseAsync();
    service = new ManagedWorktreeService({ env, getConfig: () => ({ worktreeMaxCount: 4 }) });
    vi.mocked(backend.cloneTemplate).mockImplementation(createCopyWorktreeBackend().cloneTemplate);
    const completed = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        service.create({
          repoRoot: repo,
          suggestedName: `crashed-${index}`,
          baseRef: "HEAD",
          ownerKind: "session",
          ownerId: `agent:main:crashed-${index}`,
        }),
      ),
    );
    expect(completed.map(({ name }) => name).toSorted()).toEqual([
      "crashed-0-2",
      "crashed-1-2",
      "crashed-2-2",
    ]);
    await expect(
      service.create({ repoRoot: repo, name: "crashed-0", baseRef: "HEAD" }),
    ).rejects.toThrow(/retained.*unused name/);
    for (const record of completed) {
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    }
    expect((await readPendingWorktrees(env)).every(({ state }) => state === "recovering")).toBe(
      true,
    );
    expect(await listTemplatesAsync(env)).toEqual([
      expect.objectContaining({ status: "ready", id: expect.not.stringMatching(template.id) }),
    ]);
  });

  it("creates an empty workspace without retaining or cloning an empty template", async () => {
    const created = await service.createEmpty({
      ownerKind: "session",
      ownerId: "agent:main:empty",
      name: "empty",
    });

    expect(await fs.readdir(created.path)).toEqual([".git"]);
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await listTemplatesAsync(env)).toEqual([]);
    expect(backend.cloneTemplate).not.toHaveBeenCalled();
  });

  it("preserves relative Git environment paths during registration and checkout", async () => {
    const destination = path.join(path.dirname(repo), "relative-env");
    const commit = await git(repo, "rev-parse", "HEAD");
    vi.stubEnv("GIT_COMMON_DIR", "../repo/.git");

    const result = await addManagedWorktree({
      env,
      now: () => now,
      enabled: false,
      repoRoot: repo,
      commonDir: path.join(repo, ".git"),
      worktreeRoot: path.dirname(destination),
      destination,
      base: commit,
      requireSpace: async () => {},
      commitGuard: () => {},
    });

    expect(result.code).toBe(0);
    expect(await fs.readFile(path.join(destination, "README.md"), "utf8")).toBe("base\n");
    expect(await git(destination, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(destination, "status", "--porcelain")).toBe("");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it.each(["small", "remote-restore", "invalid", "fallback"])(
    "admits only reusable source clones under disk pressure (%s)",
    async (mode) => {
      const sourceBytes = mode === "small" ? 32 * 1024 : 32 * 1024 ** 2;
      await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(sourceBytes, 7));
      await git(repo, "add", "large.bin");
      await git(repo, "commit", "-m", "large source");
      const restores = mode === "remote-restore";
      if (restores) {
        await git(repo, "push", "origin", "main");
      }
      let restoreId: string | undefined;
      const seed = await service.create({
        repoRoot: repo,
        name: "seed",
        baseRef: restores ? "origin/main" : "HEAD",
      });
      if (restores) {
        expect(await git(repo, "config", "--get", `branch.${seed.branch}.remote`)).toBe("origin");
        await fs.writeFile(path.join(seed.path, "README.md"), "saved work\n");
        await service.remove({ id: seed.id, reason: "archive" });
        restoreId = seed.id;
        await expect(
          git(repo, "config", "--get", `branch.${seed.branch}.remote`),
        ).rejects.toThrow();
      }
      if (mode === "invalid") {
        await fs.writeFile(
          path.join((await listTemplatesAsync(env))[0]!.path, "README.md"),
          "changed template",
        );
      }
      if (mode === "fallback") {
        vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("clone unavailable"));
      }
      const available = 4 * 1024 ** 3 + (mode === "small" ? 1 : 24) * 1024 ** 2;
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
      if (restores || mode === "small") {
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
    },
  );

  it("admits the registered commit before replacing a warm template and pins fallback to it", async () => {
    const initial = await git(repo, "rev-parse", "HEAD");
    const sourceBytes = 32 * 1024 ** 2;
    await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(sourceBytes, 7));
    await git(repo, "add", "large.bin");
    await git(repo, "commit", "-m", "larger checkout source");
    const larger = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "--detach", initial);
    const sourceRef = "refs/remotes/origin/racing";
    await git(repo, "update-ref", sourceRef, initial);
    await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
    const before = await service.listRegistryRecords();
    const stats = fsSync.statfsSync(repo);
    let available = 4 * 1024 ** 3 + 24 * 1024 ** 2;
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
    for (const template of await listTemplatesAsync(env)) {
      await expect(fs.access(path.join(template.path, "large.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    available = 4 * 1024 ** 3 + 96 * 1024 ** 2;
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
  });

  it("reuses deep source while including current ignored files and running setup for each checkout", async () => {
    const root = path.dirname(repo);
    const deepRepo = path.join(root, "repository-".padEnd(190 - root.length - 1, "r"));
    await fs.rename(repo, deepRepo);
    repo = await fs.realpath(deepRepo);
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

    const sourceStatus = await git(repo, "status", "--porcelain", "--untracked-files=all");
    const inspectCopy = async (checkout: string) => {
      const template = (await listTemplatesAsync(env))[0]!;
      const sourceIndex = path.resolve(
        template.path,
        await git(template.path, "rev-parse", "--git-path", "index"),
      );
      const copiedIndex = path.resolve(
        checkout,
        await git(checkout, "rev-parse", "--git-path", "index"),
      );
      const [sourceStat, copiedStat, sourceBytes, copiedBytes] = await Promise.all([
        fs.stat(sourceIndex, { bigint: true }),
        fs.stat(copiedIndex, { bigint: true }),
        fs.readFile(sourceIndex),
        fs.readFile(copiedIndex),
      ]);
      const cloneMetadata =
        process.platform === "darwin" && probeTreeClone(path.dirname(copiedIndex)) === "apfs"
          ? await readCloneFileMetadata([sourceIndex, copiedIndex])
          : undefined;
      return { sourceStat, copiedStat, sourceBytes, copiedBytes, cloneMetadata };
    };
    const copies: Awaited<ReturnType<typeof inspectCopy>>[] = [];
    const inspectionErrors: unknown[] = [];
    const run = commandRunner.runCommandWithTimeout;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("update-index") && argv.includes("--refresh")) {
        // Retain observations before Git rewrites the copy; assert outside product recovery.
        try {
          copies.push(await inspectCopy(argv[argv.indexOf("-C") + 1]!));
        } catch (error) {
          inspectionErrors.push(error);
        }
      }
      return await run(argv, options);
    });
    const first = await service.create({
      repoRoot: repo,
      name: "first-deep-source-checkout",
      baseRef: "HEAD",
    });
    expect((await git(first.path, "rev-parse", "--absolute-git-dir")).length).toBeGreaterThan(220);
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    expect(template?.status).toBe("ready");
    await fs.writeFile(path.join(repo, ".env.local"), "second\n");
    await fs.writeFile(path.join(first.path, "README.md"), "first checkout edit\n");
    const second = await service.create({
      repoRoot: repo,
      name: "second-deep-source-checkout",
      baseRef: "HEAD",
    });

    expect(backend.createTemplate).toHaveBeenCalledTimes(1);
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(inspectionErrors).toEqual([]);
    expect(copies).toHaveLength(2);
    for (const { sourceStat, copiedStat, sourceBytes, copiedBytes, cloneMetadata } of copies) {
      expect(copiedBytes).toEqual(sourceBytes);
      expect([copiedStat.dev, copiedStat.ino]).not.toEqual([sourceStat.dev, sourceStat.ino]);
      if (process.platform !== "win32") {
        expect(copiedStat.mode & 0o777n).toBe(sourceStat.mode & 0o777n);
      }
      if (cloneMetadata) {
        const [sourceMetadata, copiedMetadata] = cloneMetadata;
        expect(sourceMetadata?.cloneId).toBeTruthy();
        expect(copiedMetadata?.cloneId).toBe(sourceMetadata?.cloneId);
      }
    }
    expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
    expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe(sourceStatus);
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

  it.each(["ignored", "HEAD"] as const)(
    "rebuilds a template with %s contamination before creating another checkout",
    async (change) => {
      await fs.writeFile(path.join(repo, ".gitignore"), "ignored-*\n");
      await git(repo, "add", ".gitignore");
      await git(repo, "commit", "-m", "ignore template fixture");
      // The older commit has identical files, so HEAD validation cannot be
      // replaced by comparing the tree or accepting a clean inventory alone.
      await git(repo, "commit", "--allow-empty", "-m", "new template base");
      await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
      const original = (await listTemplatesAsync(env))[0];
      assert(original);
      const unusualName = process.platform === "win32" ? "é space.txt" : "é space\nname.txt";
      if (change === "HEAD") {
        await git(original.path, "checkout", "--detach", "HEAD~1");
      } else {
        await fs.writeFile(
          path.join(original.path, `ignored-${unusualName}`),
          "template contamination\n",
        );
      }

      const created = await service.create({
        repoRoot: repo,
        name: "replacement",
        baseRef: "HEAD",
      });

      const replacement = (await listTemplatesAsync(env))[0];
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

  it.each(["advanced", "detached"])(
    "preserves files when clone fallback finds a %s worktree HEAD",
    async (change) => {
      const initial = await git(repo, "rev-parse", "HEAD");
      const later = await git(repo, "commit-tree", "HEAD^{tree}", "-p", initial, "-m", "later");
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
        } else {
          await git(repo, "--git-dir", registration, "update-ref", "--no-deref", "HEAD", initial);
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
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(
        destination.split(path.sep).join("/"),
      );
      expect(await git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(
        change === "advanced" ? later : initial,
      );
      const symbolic = git(repo, "--git-dir", registration, "symbolic-ref", "HEAD");
      if (change === "detached") {
        await expect(symbolic).rejects.toThrow();
      } else {
        expect(await symbolic).toBe(`refs/heads/${branch}`);
      }
      expect(await service.listRegistryRecords()).toEqual([]);
    },
  );

  it("preserves an in-progress clone while garbage collection skips its pending path", async ({
    signal,
  }) => {
    acceleration = false;
    const existing = await service.create({ repoRoot: repo, name: "existing", baseRef: "HEAD" });
    acceleration = true;
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
    const creation = service.create({ repoRoot: repo, name: "allocating", baseRef: "HEAD" });
    let collection: ReturnType<typeof service.gc> | undefined;
    try {
      const destination = await awaitGateBeforeSettlement(
        cloneStarted.promise,
        creation,
        "Creation completed without starting a clone",
      );
      collection = service.gc();
      await racePromiseWithAbortSignal(
        awaitGateBeforeSettlement(
          collection,
          creation,
          "Creation completed before collection skipped the pending clone",
        ),
        signal,
      );
      expect(await fs.readFile(path.join(destination, "partial.txt"), "utf8")).toBe(
        "in-progress clone\n",
      );
    } finally {
      finishClone.resolve();
      await Promise.all([creation, collection]);
    }
    assert(collection);
    const created = await creation;
    expect((await collection).orphansDeleted).toBe(0);
    expect((await service.listRegistryRecords()).map((record) => record.id).toSorted()).toEqual(
      [existing.id, created.id].toSorted(),
    );
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it("retains expired snapshots and templates until allocation cleanup can run", async () => {
    const created = await service.create({ repoRoot: repo, name: "expired", baseRef: "HEAD" });
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;
    const allocation = vi
      .spyOn(stateLease, "withOpenClawStateLeaseAsync")
      .mockRejectedValue(new Error("allocation lease unavailable"));

    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(await service.listRegistryRecords()).toEqual([
      expect.objectContaining({ id: created.id, snapshotRef: removed.snapshotRef }),
    ]);
    expect(await git(repo, "rev-parse", removed.snapshotRef!)).toMatch(/^[a-f0-9]+$/u);
    expect(await listTemplatesAsync(env)).toHaveLength(1);
    allocation.mockRestore();

    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(await service.listRegistryRecords()).toEqual([]);
    await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
    expect(await listTemplatesAsync(env)).toEqual([]);
  });

  it("rereads template activity after waiting for its mutation lease", async (ctx) => {
    await service.create({ repoRoot: repo, name: "retained", baseRef: "HEAD" });
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    now += IDLE_GC_MS + 1;
    const held = createDeferredCore<stateLease.OpenClawStateLeaseContext>();
    const release = createDeferredCore();
    const templateKey = `template:${template.cacheKey}`;
    const holder = stateLease.withOpenClawStateLease(
      {
        scope: "core:managed-worktrees:mutation",
        key: templateKey,
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
    const templateRequested = createDeferredCore();
    const acquireLease = stateLease.withOpenClawStateLeaseAsync;
    vi.spyOn(stateLease, "withOpenClawStateLeaseAsync").mockImplementation((options, ...args) => {
      if (options.scope === "core:managed-worktrees:mutation" && options.key === templateKey) {
        templateRequested.resolve();
      }
      return acquireLease(options, ...args);
    });
    const pending = service.gc();
    try {
      await racePromiseWithAbortSignal(
        awaitGateBeforeSettlement(
          templateRequested.promise,
          pending,
          "Collection completed without requesting template custody",
        ),
        ctx.signal,
      );
      const guard = () => lease.assertOwned();
      const reader = "activity-refresh";
      await retainTemplateReaderAsync(
        env,
        {
          id: template.id,
          key: reader,
          owner: { pid: process.pid, host: hostname(), startedAt: null },
          unpublish: true,
        },
        guard,
      );
      try {
        expect(await markTemplateReadyAsync(env, template.id, now, guard)).toBe(true);
      } finally {
        await releaseTemplateReaderAsync(env, reader, guard);
      }
    } finally {
      release.resolve();
      try {
        await holder;
      } finally {
        await pending;
      }
    }
    expect((await pending).removed).toEqual([]);
    expect(await listTemplatesAsync(env)).toEqual([{ ...template, lastUsedAt: now }]);
    expect(await fs.readFile(path.join(template.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("fences revoked creation authority when snapshot and native fallback both fail", async () => {
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
    const queued = createDeferredCore();
    const enqueue = gitExec.enqueueGitRefMutation;
    vi.spyOn(gitExec, "enqueueGitRefMutation").mockImplementation((...args) => {
      queued.resolve();
      return enqueue(...args);
    });
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
      await awaitGateBeforeSettlement(
        queued.promise,
        pending,
        "Checkout ended before cleanup queued its branch deletion",
      );
      expect(failedDestination).toBeDefined();
      expect(await git(repo, "rev-parse", branch)).toBe(originalHead);
      await expect(fs.access(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
      const [slot] = await readPendingWorktrees(env);
      assert(slot);
      expect(slot.record.path).toBe(failedDestination);
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const changed = executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
              .deleteFrom("state_leases")
              .where("scope", "=", "core:managed-worktrees:mutation")
              .where("lease_key", "=", slot.record.id),
          );
          expect(changed.numAffectedRows).toBe(1n);
        },
        { env },
      );
      release.resolve();
      await holder;
      const error = await pending;
      expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(await git(repo, "branch", "--list", branch)).toBe(branch);
      expect(await git(repo, "rev-parse", branch)).toBe(originalHead);

      expect(failedDestination).toBeDefined();
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("failed-fallback");
      expect(await service.listRegistryRecords()).toEqual([]);
      await expect(fs.access(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await holder;
      await pending;
    }
  });

  it.each([false, true])(
    "restores saved edits and retains the source template (clone failure=%s)",
    async (cloneFails) => {
      const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
      const template = (await listTemplatesAsync(env))[0];
      assert(template);
      const originalCommit = await git(created.path, "rev-parse", "HEAD");
      await fs.writeFile(path.join(created.path, "README.md"), "saved edit\n");
      await fs.writeFile(path.join(created.path, "untracked.txt"), "saved new file\n");
      await service.remove({ id: created.id, reason: "test" });
      if (cloneFails) {
        vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("clone unavailable"));
      }
      const restored = await service.restore({ id: created.id });
      expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
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
      expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
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
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    await fs.writeFile(path.join(created.path, ".gitattributes"), "*.md text eol=crlf\n");
    await service.remove({ id: created.id, reason: "test" });

    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\r\n");
    expect(await git(restored.path, "status", "--porcelain")).toBe("?? .gitattributes");
    expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
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
});
