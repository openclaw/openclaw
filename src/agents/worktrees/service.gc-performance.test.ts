import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import * as checkoutInspection from "./checkout-inspection.js";
import { repairWorktreePackIndex } from "./git-maintenance.js";
import { requireGit, runGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import * as registry from "./registry.js";
import { deleteRegistryWorktree, insertRegistryWorktree } from "./registry.js";
import { getRegistryWorktree, listRegistryWorktrees } from "./registry.test-support.js";
import { admitWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import { resolveRepository } from "./service-preparation.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { hasTemplatesAsync } from "./template-registry-async.js";

describe("worktree Git maintenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("worktree-gc-maintenance-state-"),
  };

  const initRepo = useManagedWorktreeTestRepository();

  beforeAll(async () => {
    await registryReads.readRegistryWorktrees(env);
    await registryReads.readWorktreeCleanupState(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const record of listRegistryWorktrees(env)) {
      await deleteRegistryWorktree(env, record.id);
    }
  });

  it("rebuilds pack lookup when its previous index names a removed pack", async () => {
    const repo = await initRepo(tempDirs.make("worktree-stale-pack-index-"));
    const packDirectory = path.join(repo, ".git", "objects", "pack");
    const indexPath = path.join(packDirectory, "multi-pack-index");
    await requireGit(repo, ["repack", "-a", "-d"]);
    await repairWorktreePackIndex(repo);
    const staleIndex = await fs.readFile(indexPath);
    const oldPacks = new Set(
      (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx")),
    );
    await fs.writeFile(path.join(repo, "replacement.txt"), "replacement pack\n");
    await requireGit(repo, ["add", "replacement.txt"]);
    await requireGit(repo, ["commit", "-m", "replace pack"]);
    await requireGit(repo, ["repack", "-a", "-d"]);
    const currentPacks = (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx"));
    expect(currentPacks.every((name) => !oldPacks.has(name))).toBe(true);
    // Reproduce an interrupted pack replacement without removing any reachable objects.
    await fs.writeFile(indexPath, staleIndex);

    await repairWorktreePackIndex(repo);

    await requireGit(repo, ["multi-pack-index", "verify"]);
    expect(await requireGit(repo, ["show", "HEAD:replacement.txt"])).toBe("replacement pack");
  });

  it("maintains each shared repository and suspends failures until explicitly retried", async () => {
    const repo = await initRepo(tempDirs.make("worktree-gc-first-repo-"));
    const otherRepo = await initRepo(tempDirs.make("worktree-gc-second-repo-"));
    for (const repoRoot of [repo, otherRepo]) {
      await requireGit(repoRoot, ["repack", "-d"]);
    }
    for (const [index, repoRoot] of [repo, repo, otherRepo].entries()) {
      const name = `manual-${index}`;
      const worktreePath = path.join(repoRoot, name);
      await fs.mkdir(worktreePath);
      await insertRegistryWorktree(env, {
        id: name,
        name,
        repoFingerprint: name,
        repoRoot,
        path: worktreePath,
        branch: `openclaw/${name}`,
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      });
    }
    const service = new ManagedWorktreeService({ env, now: () => 3 });
    const controller = new AbortController();
    const execute = gitExec.executeGitCommand;
    const maintenanceRoots: string[] = [];
    const repairRoots: string[] = [];
    const taskOrders: string[][] = [];
    const commands = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "multi-pack-index") {
          repairRoots.push(cwd);
        }
        if (args[0] !== "maintenance") {
          return await execute(cwd, args, options);
        }
        expect(repairRoots.at(-1)).toBe(cwd);
        taskOrders.push(args.filter((arg) => arg.startsWith("--task=")));
        expect(options).toMatchObject({
          killProcessTree: true,
          signal: controller.signal,
          timeoutMs: 30 * 60_000,
          beforeRun: expect.any(Function),
          env: expect.objectContaining({ GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" }),
        });
        options?.beforeRun?.();
        maintenanceRoots.push(cwd);
        return {
          stdout: "",
          stderr: cwd === repo ? "gc is already running" : "",
          code: cwd === repo ? 1 : 0,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: options?.timeoutMs ?? 120_000,
        };
      });
    const logs = createWarnLogCapture("worktree-gc-maintenance");
    try {
      const result = await service.gc({ signal: controller.signal });
      expect(result).toMatchObject({
        removed: [],
        outcome: "completed",
        issues: [],
        issueCount: 0,
      });
      expect(maintenanceRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
      expect(repairRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
      // Git honors task order; graph traversal must not starve pack-index repair.
      expect(taskOrders).toEqual(
        [repo, otherRepo].map(() => ["--task=commit-graph", "--task=loose-objects"]),
      );
      const warning = await logs.findText("worktree Git maintenance");
      expect(warning).toContain("gc is already running");
      // Removal must still repair this repo after broad maintenance has been suspended.
      await repairWorktreePackIndex(repo, { signal: controller.signal });
      expect(repairRoots.at(-1)).toBe(repo);
      await service.gc({ signal: controller.signal });
      expect(maintenanceRoots).toHaveLength(3);
      expect(repairRoots).toHaveLength(4);
      expect(maintenanceRoots.at(-1)).toBe(otherRepo);
      await service.gc({ signal: controller.signal, retryDeferred: true });
      expect(maintenanceRoots).toHaveLength(5);
      expect(repairRoots).toHaveLength(6);
      const calls = commands.mock.calls.length;
      controller.abort(new Error("cleanup cancelled"));
      await expect(service.gc({ signal: controller.signal })).rejects.toThrow("cleanup cancelled");
      expect(commands).toHaveBeenCalledTimes(calls);
    } finally {
      logs.cleanup();
    }
  });

  it("maintains partial clones without fetching missing historical heads", async () => {
    const root = tempDirs.make("worktree-maintenance-partial-clone-");
    const source = await initRepo(root);
    await requireGit(source, ["config", "uploadpack.allowFilter", "true"]);
    const clone = path.join(root, "clone");
    await requireGit(root, [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(source).href,
      clone,
    ]);
    await requireGit(source, ["commit", "--allow-empty", "-m", "historical head"]);
    const missing = await requireGit(source, ["rev-parse", "HEAD"]);
    // A retained branch can outlive the partial clone's locally available objects.
    await fs.writeFile(path.join(clone, ".git", "refs", "heads", "historical"), `${missing}\n`);
    await requireGit(clone, ["config", "maintenance.commit-graph.auto", "-1"]);
    await insertRegistryWorktree(env, {
      id: "partial-clone",
      name: "partial-clone",
      repoFingerprint: "partial-clone",
      repoRoot: clone,
      path: clone,
      branch: "main",
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
    const trace = path.join(root, "maintenance-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    vi.stubEnv("GIT_NO_LAZY_FETCH", undefined);
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
    try {
      expect((await new ManagedWorktreeService({ env, now: () => 3 }).gc()).outcome).toBe(
        "completed",
      );
      expect(await fs.readFile(trace, "utf8")).not.toContain("upload-pack");
      expect(
        (
          await runGit(clone, ["cat-file", "-e", missing], {
            env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
          })
        ).code,
      ).not.toBe(0);
      await fs.access(
        path.join(clone, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("warns without changing completed cleanup when the maintenance inventory fails", async () => {
    vi.spyOn(registryReads, "readRegistryWorktrees").mockRejectedValueOnce(
      new Error("maintenance inventory unavailable"),
    );
    const logs = createWarnLogCapture("worktree-gc-inventory");
    try {
      const result = await new ManagedWorktreeService({ env }).gc();
      expect(result).toMatchObject({
        removed: [],
        outcome: "completed",
        issues: [],
        issueCount: 0,
      });
      expect(await logs.findText("worktree Git maintenance inventory failed")).toContain(
        "maintenance inventory unavailable",
      );
    } finally {
      logs.cleanup();
    }
  });

  it("consolidates indexed promisor packs without fetching, losing local objects, or removing kept packs", async () => {
    const root = tempDirs.make("worktree-pack-consolidation-");
    const source = await initRepo(root);
    await requireGit(source, ["config", "uploadpack.allowFilter", "true"]);
    const repo = path.join(root, "partial");
    await requireGit(root, [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(source).href,
      repo,
    ]);
    const packDirectory = path.join(repo, ".git", "objects", "pack");
    const missing = await requireGit(repo, ["rev-list", "--objects", "--all", "--missing=print"]);
    expect(missing).toContain("?");
    const objects: string[] = [];
    const generated: string[] = [];
    for (let index = 0; index < 18; index++) {
      const object = await requireGit(repo, ["hash-object", "-w", "--stdin"], {
        input: `payload-${index}`,
      });
      objects.push(object);
      const hash = await requireGit(repo, ["pack-objects", path.join(packDirectory, "pack")], {
        input: `${object}\n`,
      });
      generated.push(`pack-${hash}`);
      if (index < 17) {
        await fs.writeFile(path.join(packDirectory, `pack-${hash}.promisor`), "");
      }
    }
    const kept = generated[0]!;
    await fs.writeFile(path.join(packDirectory, `${kept}.keep`), "retained by another owner");
    await requireGit(repo, ["prune-packed"]);
    await repairWorktreePackIndex(repo);
    await insertRegistryWorktree(env, {
      id: "consolidate",
      name: "consolidate",
      repoFingerprint: "consolidate",
      repoRoot: repo,
      path: repo,
      branch: "main",
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
    const trace = path.join(root, "pack-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    try {
      expect((await new ManagedWorktreeService({ env, now: () => 3 }).gc()).outcome).toBe(
        "completed",
      );
      const remaining = await fs.readdir(packDirectory);
      expect(remaining.filter((name) => name.endsWith(".pack"))).toHaveLength(3);
      expect(remaining).toContain(`${kept}.pack`);
      expect(remaining).toContain(`${generated[17]}.pack`);
      expect(remaining.filter((name) => name.endsWith(".promisor"))).toHaveLength(2);
      expect(
        await requireGit(repo, ["cat-file", "--batch-check"], {
          input: `${objects.join("\n")}\n`,
          env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
        }),
      ).not.toContain("missing");
      expect(await requireGit(repo, ["rev-list", "--objects", "--all", "--missing=print"])).toBe(
        missing,
      );
      await requireGit(repo, ["multi-pack-index", "verify"]);
      expect(await fs.readFile(trace, "utf8")).not.toContain("upload-pack");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "removes old abandoned temporary packs only after their open writer closes",
    async () => {
      const repo = await initRepo(tempDirs.make("worktree-temporary-packs-"));
      const directory = path.join(repo, ".git", "objects", "pack");
      const old = path.join(directory, "tmp_pack_abandoned");
      const active = path.join(directory, "tmp_pack_active");
      const young = path.join(directory, "tmp_pack_young");
      const unrelated = path.join(directory, "operator-note");
      const link = path.join(directory, "tmp_pack_symlink");
      for (const file of [old, active, young, unrelated]) {
        await fs.writeFile(file, "retain or reclaim");
      }
      const yesterday = new Date(Date.now() - 48 * 60 * 60_000);
      for (const file of [old, active, unrelated]) {
        await fs.utimes(file, yesterday, yesterday);
      }
      await fs.symlink(unrelated, link);
      // A full batch of retained paths must not starve later abandoned packs.
      for (let index = 0; index < 256; index++) {
        await fs.symlink(unrelated, path.join(directory, `tmp_pack_aaa${index}`));
      }
      await insertRegistryWorktree(env, {
        id: "temporary",
        name: "temporary",
        repoFingerprint: "temporary",
        repoRoot: repo,
        path: repo,
        branch: "main",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      });
      const service = new ManagedWorktreeService({ env, now: () => 3 });
      const writer = await fs.open(active, "r+");
      try {
        await service.gc();
        await fs.access(active);
        await expect(fs.access(old)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await writer.close();
      }
      await service.gc();
      await expect(fs.access(old)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(active)).rejects.toMatchObject({ code: "ENOENT" });
      for (const file of [young, unrelated, link]) {
        await fs.access(file);
      }
    },
  );

  it("preserves shared reflog history and maintains repositories with already-missing reflog objects", async () => {
    const root = tempDirs.make("worktree-maintenance-reflogs-");
    const repo = await initRepo(root);
    const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
    await git(repo, "config", "gc.auto", "0");
    const [survivor, removed] = await materializeManagedWorktreeFixtures({
      env,
      stateDir: root,
      repoRoot: repo,
      names: ["survivor", "removed"],
      now: 1,
    });
    const base = await git(repo, "rev-parse", "HEAD");
    await git(survivor!.path, "checkout", "--detach");
    await git(survivor!.path, "commit", "--allow-empty", "-m", "reflog-only commit");
    const retained = await git(survivor!.path, "rev-parse", "HEAD");
    await git(survivor!.path, "checkout", survivor!.branch);
    const service = new ManagedWorktreeService({ env, now: () => 3 });
    const removedLog = path.resolve(
      removed!.path,
      await git(removed!.path, "rev-parse", "--git-path", "logs/HEAD"),
    );
    await fs.access(removedLog);
    await service.remove({ id: removed!.id, reason: "test" });
    await expect(fs.access(removedLog)).rejects.toMatchObject({ code: "ENOENT" });
    await git(repo, "repack", "-d");
    const missing = "a".repeat(base.length);
    const broken = await requireGit(repo, ["hash-object", "-w", "-t", "commit", "--stdin"], {
      input: Buffer.from(
        `tree ${missing}\nparent ${base}\nauthor Test <test@example.invalid> 1780000000 +0000\ncommitter Test <test@example.invalid> 1780000000 +0000\n\nmissing reflog tree\n`,
      ),
    });
    const reflog = path.resolve(
      survivor!.path,
      await git(survivor!.path, "rev-parse", "--git-path", "logs/HEAD"),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    await fs.appendFile(
      reflog,
      `${base} ${broken} Test <test@example.invalid> ${timestamp} +0000\tmissing tree\n${broken} ${missing} Test <test@example.invalid> ${timestamp} +0000\tmissing commit\n`,
    );
    const history = await fs.readFile(reflog, "utf8");
    for (let index = 0; index < 3; index++) {
      const object = await requireGit(repo, ["hash-object", "-w", "--stdin"], {
        input: Buffer.from(`pack-${index}`),
      });
      await requireGit(repo, ["pack-objects", path.join(repo, ".git", "objects", "pack", "pack")], {
        input: Buffer.from(`${object}\n`),
      });
    }
    await git(repo, "config", "gc.auto", "1");
    await git(repo, "config", "gc.autoPackLimit", "1");
    for (const task of ["commit-graph", "loose-objects", "incremental-repack"]) {
      await git(repo, "config", `maintenance.${task}.auto`, "-1");
    }
    const logs = createWarnLogCapture("worktree-maintenance-reflogs");
    try {
      expect((await service.gc()).outcome).toBe("completed");
      expect(await logs.findText("worktree Git maintenance")).toBeUndefined();
      expect(await fs.readFile(reflog, "utf8")).toBe(history);
      expect(await git(repo, "cat-file", "-t", retained)).toBe("commit");
      await fs.access(
        path.join(repo, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
      );
    } finally {
      logs.cleanup();
    }
  });
});

describe("worktree GC inventories", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await stateDatabase.closeOpenClawStateDatabaseAsync();
      stateDatabase.closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  const initializeRepository = useManagedWorktreeTestRepository();

  function isRepositoryMaintenance(args: readonly string[]): boolean {
    return (
      args[0] === "maintenance" ||
      args[0] === "multi-pack-index" ||
      (args[0] === "rev-parse" && args[1] === "--git-common-dir") ||
      (args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "objects/pack")
    );
  }

  it("bounds cold cleanup inventories and retains dispositions across registry reopen", async () => {
    const root = tempDirs.make("openclaw-gc-spawns-");
    const repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const now = IDLE_GC_MS + 10;
    const records = await materializeManagedWorktreeFixtures({
      env,
      stateDir,
      repoRoot: repo,
      now,
      ownerKind: "session",
      names: Array.from({ length: 40 }, (_, index) => `checkout-${index}`),
    });
    const repository = await resolveRepository(repo);
    for (const record of records) {
      await registry.updateRegistryWorktree(env, record.id, {
        repositoryIdentity: {
          repoRoot: repository.repoRoot,
          repoFingerprint: repository.fingerprint,
        },
      });
    }
    for (const record of records.slice(0, 9)) {
      await registry.updateRegistryWorktree(env, record.id, { lastActiveAt: 1 });
    }
    for (const record of records.slice(0, 4)) {
      await fs.mkdir(path.join(record.path, "nested", ".git"), { recursive: true });
    }
    for (const record of records.slice(4, 7)) {
      await requireGit(record.path, ["checkout", "--detach"]);
    }
    await fs.rm(path.join(records[7]!.path, ".git"));
    const missingRepository = path.join(root, "missing-repository");
    await fs.mkdir(missingRepository);
    await fs.writeFile(path.join(missingRepository, ".git"), "gitdir: missing\n");
    await registry.updateRegistryWorktree(env, records[8]!.id, {
      repositoryIdentity: { repoRoot: missingRepository, repoFingerprint: "missing" },
    });
    const text = vi.spyOn(gitExec, "executeGitCommand");
    const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
    const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
    const measurements = [];
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        await stateDatabase.closeOpenClawStateDatabaseAsync();
        stateDatabase.closeOpenClawStateDatabaseForTest();
      }
      text.mockClear();
      bytes.mockClear();
      buffered.mockClear();
      const started = performance.now();
      const result = await new ManagedWorktreeService({
        env,
        now: () => now + pass * 3_600_000,
      }).gc();
      measurements.push({
        pass,
        gitSpawns:
          text.mock.calls.filter(([, args]) => !isRepositoryMaintenance(args)).length +
          bytes.mock.calls.length +
          buffered.mock.calls.length,
        elapsedMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
      });
      expect(result.removed).toEqual([]);
      for (const record of records) {
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      }
    }
    console.log(JSON.stringify({ records: records.length, measurements }));
    expect(measurements[0]!.gitSpawns).toBeLessThanOrEqual(50);
    expect(measurements[1]!.gitSpawns).toBe(0);
    expect(
      records.slice(0, 9).every((record) => getRegistryWorktree(env, record.id)?.gcProtection),
    ).toBe(true);
    // A managed owner revision reopens only that record, even if it is still idle.
    await registry.updateRegistryWorktree(env, records[0]!.id, { lastActiveAt: 2 });
    text.mockClear();
    bytes.mockClear();
    buffered.mockClear();
    await new ManagedWorktreeService({ env, now: () => now }).gc();
    const inspectedPaths = [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls]
      .filter(([, args]) => !isRepositoryMaintenance(args))
      .map(([cwd]) => cwd);
    expect(inspectedPaths).toContain(records[0]!.path);
    expect(inspectedPaths.every((cwd) => cwd === repo || cwd === records[0]!.path)).toBe(true);
    // External repairs have an explicit retry path without changing configuration.
    await fs.rm(path.join(records[0]!.path, "nested"), { recursive: true });
    const explicit = new ManagedWorktreeService({ env, now: () => now });
    vi.spyOn(explicit, "remove").mockRejectedValueOnce(new Error("transient removal failure"));
    expect((await explicit.gc({ retryDeferred: true })).outcome).toBe("partial");
    expect(getRegistryWorktree(env, records[0]!.id)?.gcProtection).toBeUndefined();
    const retried = await new ManagedWorktreeService({ env, now: () => now }).gc();
    expect(retried.removed).toEqual([records[0]!.id]);
    await registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: 3 });
    const inspect = checkoutInspection.inspectManagedWorktreeCheckout;
    vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout").mockImplementation(
      async (...args) => {
        const result = await inspect(...args);
        if (args[0].id === records[1]!.id && args[1] === "nested-repository") {
          await registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: now });
        }
        return result;
      },
    );
    await new ManagedWorktreeService({ env, now: () => now }).gc();
    expect(getRegistryWorktree(env, records[1]!.id)?.gcProtection).toBeUndefined();
  });

  it("rescans protected checkouts only when their root or HEAD changes", async () => {
    const root = tempDirs.make("openclaw-gc-fingerprint-");
    const repoRoot = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const [nested, moved] = await materializeManagedWorktreeFixtures({
      env,
      stateDir,
      repoRoot,
      now: 1,
      ownerKind: "session",
      names: ["nested", "moved"],
    });
    await fs.mkdir(path.join(nested!.path, "inner", ".git"), { recursive: true });
    await requireGit(moved!.path, ["checkout", "-b", "external-branch"]);
    await requireGit(repoRoot, ["pack-refs", "--all"]);
    const service = new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 });
    const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");

    const first = await service.gc();
    expect(first.removed).toEqual([]);
    expect(first.protectionReasons).toEqual({
      "worktree contains a nested repository": 1,
      "branch-moved": 1,
    });
    expect(inspections).toHaveBeenCalled();
    inspections.mockClear();
    // Packing an unrelated branch must not invalidate these unchanged checkout tips.
    await requireGit(repoRoot, ["update-ref", "refs/heads/unrelated", "HEAD"]);
    await requireGit(repoRoot, ["pack-refs", "--all"]);
    expect((await service.gc()).removed).toEqual([]);
    expect(inspections).not.toHaveBeenCalled();

    // External repair changes the checkout fingerprint, not its registry revision.
    await fs.rm(path.join(nested!.path, "inner"), { recursive: true });
    expect(getRegistryWorktree(env, nested!.id)?.lastActiveAt).toBe(1);
    expect((await service.gc()).removed).toEqual([nested!.id]);
    expect(inspections.mock.calls.length).toBeGreaterThan(0);
    expect(inspections.mock.calls.every(([record]) => record.id === nested!.id)).toBe(true);
    inspections.mockClear();
    await requireGit(moved!.path, ["checkout", moved!.branch]);
    expect(getRegistryWorktree(env, moved!.id)?.lastActiveAt).toBe(1);
    expect((await service.gc()).removed).toEqual([moved!.id]);
    expect(inspections.mock.calls.length).toBeGreaterThan(0);
    expect(inspections.mock.calls.every(([record]) => record.id === moved!.id)).toBe(true);
  });

  async function addLeasedWorktree(env: NodeJS.ProcessEnv, root: string, id: string) {
    await registry.insertRegistryWorktree(env, {
      id,
      name: id,
      repoFingerprint: "0123456789abcdef",
      repoRoot: root,
      path: root,
      branch: `openclaw/${id}`,
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: id,
      createdAt: 1,
      lastActiveAt: 1,
    });
    stateDatabase.runOpenClawStateWriteTransaction(
      ({ db }) =>
        admitWorktreeRunLeaseInDatabase(db, {
          worktreeId: id,
          token: id,
          pid: process.pid,
          startTime: null,
          now: 1,
        }),
      { env },
    );
  }

  it("protects a sweep of live leases without writer admission or checkout inspection", async () => {
    const root = tempDirs.make("openclaw-gc-leases-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const count = 16;
    for (let index = 0; index < count; index++) {
      const id = `leased-${index}`;
      await addLeasedWorktree(env, root, id);
    }
    await hasTemplatesAsync(env);
    const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
    const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
    const cleanupReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
    // Warm the retained reader before measuring steady-state cleanup.
    await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc();
    expect(inspections).not.toHaveBeenCalled();
    writes.mockClear();
    reads.mockClear();
    cleanupReads.mockClear();
    inspections.mockClear();
    const started = performance.now();
    const result = await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc();
    const measurements = {
      records: count,
      writes: writes.mock.calls.length,
      registryReads: cleanupReads.mock.calls.filter(
        ([, command]) => command.type === "worktrees.cleanupState",
      ).length,
      maintenanceInventoryReads: reads.mock.calls.filter(
        ([, command]) => command.type === "worktrees.list",
      ).length,
      checkoutInspections: inspections.mock.calls.length,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
    };
    console.log(JSON.stringify(measurements));
    expect(result.removed).toEqual([]);
    expect(result.protectedCount).toBe(count);
    expect(result.issues.every((issue) => issue.reason === "run lease is active")).toBe(true);
    expect(measurements).toMatchObject({
      writes: 0,
      registryReads: 1,
      maintenanceInventoryReads: 1,
      checkoutInspections: 0,
    });
  });

  it("protects a late lease without loading removed history for cleanup limits", async () => {
    const root = tempDirs.make("openclaw-gc-late-lease-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    await addLeasedWorktree(env, root, "initial");
    await addLeasedWorktree(env, root, "second");
    await registry.insertRegistryWorktree(env, {
      ...getRegistryWorktree(env, "initial")!,
      id: "removed-history",
      removedAt: 0,
    });
    const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
    const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
    const readCleanupState = registryReads.readWorktreeCleanupState;
    let publishedLateLease = false;
    vi.spyOn(registryReads, "readWorktreeCleanupState").mockImplementation(async (options) => {
      const state = await readCleanupState(options);
      if (!publishedLateLease) {
        publishedLateLease = true;
        await addLeasedWorktree(env, root, "late");
      }
      return state;
    });
    const result = await new ManagedWorktreeService({
      env,
      now: () => IDLE_GC_MS + 2,
      getConfig: () => ({ worktreeMaxCount: 1 }),
    }).gc();
    expect(result.removed).toEqual([]);
    expect(result.protectedCount).toBe(3);
    expect(result.protectionReasons).toEqual({ "live-refused": 3 });
    expect(result.limitsSatisfied).toBe(false);
    expect(inspections).not.toHaveBeenCalled();
    const batches = await Promise.all(
      reads.mock.calls.flatMap(([, command], index) =>
        command.type === "worktrees.list" ? [reads.mock.results[index]?.value] : [],
      ),
    );
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "removed-history" })]),
      );
    }
    expect(await new ManagedWorktreeService({ env }).listRegistryRecords()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "removed-history", removedAt: 0 })]),
    );
  });
});
