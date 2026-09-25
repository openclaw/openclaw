import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { withLocalWorkspaceProjection } from "../../gateway/worker-environments/local-workspace-projection.js";
import { localWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as allocation from "./allocation.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { formatWorktreeGcResult } from "./gc-result.js";
import { requireGit } from "./git.js";
import {
  admitWorktreeRunLeaseRow,
  getRegistryWorktree,
  deleteRegistryWorktree,
  insertRegistryWorktree,
  updateRegistryWorktree,
} from "./registry.js";
import { resolveRepository } from "./service-preparation.js";
import {
  IDLE_GC_MS,
  SNAPSHOT_RETENTION_MS,
  ManagedWorktreeService,
  managedWorktrees,
} from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeGcResult } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetConfigRuntimeState();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();

async function bindFixtureRepository(env: NodeJS.ProcessEnv, repo: string, ids: string[]) {
  const identity = await resolveRepository(repo);
  for (const id of ids) {
    updateRegistryWorktree(env, id, {
      repositoryIdentity: { repoRoot: identity.repoRoot, repoFingerprint: identity.fingerprint },
    });
  }
}

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["checkout-parent", "checkout", "tracked-parent"])(
  "retains an unreadable %s across CLI cleanup sweeps",
  async (blocked) => {
    const root = tempDirs.make("openclaw-gc-unreadable-");
    const repo = await initializeRepository(root);
    await fs.mkdir(path.join(repo, "tracked"));
    await fs.writeFile(path.join(repo, "tracked", "file.txt"), "preserve unreadable content\n");
    await requireGit(repo, ["add", "tracked"]);
    await requireGit(repo, ["commit", "-m", "add tracked directory"]);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const now = 1_700_000_000_000;
    const [record] = await materializeManagedWorktreeFixtures({
      env,
      repoRoot: repo,
      stateDir,
      now: now - IDLE_GC_MS - 1,
      ownerKind: "workboard",
      names: ["unreadable"],
    });
    const service = new ManagedWorktreeService({ env, now: () => now });
    setRuntimeConfigSnapshot({}, {});
    vi.spyOn(managedWorktrees, "gc").mockImplementation(() =>
      service.gc({ limits: { maxCount: 0 } }),
    );
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);
    const locked =
      blocked === "checkout-parent"
        ? path.dirname(record!.path)
        : blocked === "checkout"
          ? record!.path
          : path.join(record!.path, "tracked");
    setLoggerOverride({ level: "warn", consoleLevel: "silent" });
    const logs = createDiagnosticLogRecordCapture();
    await fs.chmod(locked, 0o000);
    const passes = [];
    try {
      for (let pass = 0; pass < 2; pass++) {
        logs.records.length = 0;
        let exitCode = 0;
        try {
          await program.parseAsync(["worktrees", "gc", "--json"], { from: "user" });
        } catch (error) {
          if (!(error instanceof ExitError)) {
            throw error;
          }
          exitCode = error.code;
        }
        await logs.flush();
        passes.push({
          exitCode,
          errorLines: logs.records.filter((entry) =>
            [entry.message, ...Object.values(entry.attributes ?? {})].some(
              (value) => typeof value === "string" && value.includes("idle cleanup failed"),
            ),
          ).length,
          result: output.mock.lastCall?.[0],
        });
      }
      console.log(JSON.stringify({ blocked, passes }));
      for (const pass of passes) {
        expect(pass).toMatchObject({
          exitCode: 0,
          errorLines: 0,
          result: {
            outcome: "deferred",
            removed: [],
            orphansRetired: 0,
            protectedCount: 1,
            protectionReasons: { unreadable: 1 },
            issues: [
              {
                id: record!.id,
                stage: "idle",
                outcome: "deferred",
                reason: expect.stringContaining(locked),
              },
            ],
          },
        });
      }
      expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
    } finally {
      await fs.chmod(locked, 0o755);
      logs.cleanup();
      setLoggerOverride(null);
      resetLogger();
    }
    expect((await service.gc()).removed).toEqual([record!.id]);
  },
);

it("finishes CLI cleanup with moved HEADs, missing gitdirs, and 600 mixed registry records", async () => {
  const root = tempDirs.make("openclaw-gc-classification-");
  const repo = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const now = 1_700_000_000_000;
  const [moved, orphan, ...idle] = await materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir,
    now: now - IDLE_GC_MS - 1,
    ownerKind: "workboard",
    names: ["a-moved", "b-orphan", "idle-1", "idle-2", "idle-3", "idle-4"],
  });
  await bindFixtureRepository(env, repo, [
    moved!.id,
    orphan!.id,
    ...idle.map((record) => record.id),
  ]);
  await requireGit(moved!.path, ["checkout", "--detach"]);
  const gitdir = await requireGit(orphan!.path, ["rev-parse", "--absolute-git-dir"]);
  await fs.rm(gitdir, { recursive: true });
  await fs.writeFile(path.join(orphan!.path, "local.txt"), "preserve uncertain checkout files\n");
  // The cheap protected rows need no physical checkout: protection must precede Git inspection.
  runOpenClawStateWriteTransaction(
    () => {
      for (let index = 0; index < 594; index++) {
        const id = `a-protected-${String(index).padStart(3, "0")}`;
        insertRegistryWorktree(env, {
          ...moved!,
          id,
          name: id,
          path: repo,
          ownerKind: index >= 590 ? "manual" : "workboard",
          ownerId: index < 390 ? "active-owner" : id,
        });
        if (index >= 390 && index < 590) {
          admitWorktreeRunLeaseRow(env, {
            worktreeId: id,
            token: id,
            pid: process.pid,
            startTime: null,
            now,
          });
        }
      }
      admitWorktreeRunLeaseRow(env, {
        worktreeId: idle[0]!.id,
        token: "dead-owner",
        pid: 2_147_483_647,
        startTime: null,
        now,
      });
    },
    { env },
  );
  const service = new ManagedWorktreeService({ env, now: () => now });
  setRuntimeConfigSnapshot({}, {});
  let collected: ManagedWorktreeGcResult | undefined;
  vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params) => {
    collected = await service.gc({
      ...params,
      shouldProtectOwner: (_kind, id) => id === "active-owner",
      shouldRemoveOwner: () => false,
    });
    return collected;
  });
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  const protections = vi.spyOn(WorktreeGcProgress.prototype, "protect");
  const program = new Command().name("openclaw");
  registerWorktreesCli(program);
  const started = performance.now();
  let exitCode = 0;
  try {
    await program.parseAsync(["worktrees", "gc", "--json"], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  }
  const distribution: Record<string, number> = {};
  for (const call of protections.mock.calls) {
    const reason = call[2];
    distribution[reason] = (distribution[reason] ?? 0) + 1;
  }
  console.log(
    JSON.stringify({
      records: 600,
      exitCode,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      distribution,
    }),
  );
  expect(exitCode).toBe(0);
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "deferred",
      removed: idle.map((record) => record.id),
      orphansRetired: 1,
      retiredCheckoutPaths: [orphan!.path],
      protectedCount: 595,
      protectionReasons: {
        "owner is active": 390,
        "run lease is active": 200,
        "manual worktrees require explicit removal": 4,
        "branch-moved": 1,
      },
    }),
  );
  if (!collected) {
    throw new Error("CLI cleanup did not return its result");
  }
  expect(formatWorktreeGcResult(collected)).toContain(orphan!.path);
  expect(getRegistryWorktree(env, orphan!.id)?.removedAt).toBe(now);
  expect((await service.list()).some((record) => record.id === orphan!.id)).toBe(false);
  await expect(service.restore({ id: orphan!.id })).rejects.toThrow("is not restorable");
  expect(await requireGit(repo, ["rev-parse", "--verify", orphan!.branch])).toBeTruthy();
  expect(getRegistryWorktree(env, moved!.id)?.removedAt).toBeUndefined();
  expect(await requireGit(repo, ["rev-parse", "--verify", moved!.branch])).toBeTruthy();
  expect(await fs.readFile(path.join(orphan!.path, "local.txt"), "utf8")).toBe(
    "preserve uncertain checkout files\n",
  );
  for (const record of idle) {
    expect(getRegistryWorktree(env, record.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("preserves a recent orphan when its owner becomes live during cleanup", async () => {
  const root = tempDirs.make("openclaw-gc-owner-revived-");
  const repo = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const now = 1_700_000_000_000;
  const [record] = await materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir,
    now,
    ownerKind: "workboard",
    ownerId: "revived-owner",
    names: ["recent-orphan"],
  });
  await bindFixtureRepository(env, repo, [record!.id]);
  const gitdir = await requireGit(record!.path, ["rev-parse", "--absolute-git-dir"]);
  await fs.rm(gitdir, { recursive: true });
  const service = new ManagedWorktreeService({ env, now: () => now });
  const result = await service.gc({
    limits: {},
    shouldProtectOwner: () => false,
    shouldRemoveOwner: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
  });
  expect(result).toMatchObject({ removed: [], orphansRetired: 0, outcome: "deferred" });
  expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
});

it.each([
  { phase: "before cleanup", outcome: "partial" },
  { phase: "after the initial probe", outcome: "deferred" },
])(
  "preserves a broken-link record when its source origin changes $phase",
  async ({ phase, outcome }) => {
    const root = tempDirs.make("openclaw-gc-origin-changed-");
    const repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const now = 1_700_000_000_000;
    const [record] = await materializeManagedWorktreeFixtures({
      env,
      repoRoot: repo,
      stateDir,
      now: now - IDLE_GC_MS - 1,
      ownerKind: "workboard",
      names: ["changed-origin"],
    });
    await bindFixtureRepository(env, repo, [record!.id]);
    const gitdir = await requireGit(record!.path, ["rev-parse", "--absolute-git-dir"]);
    await fs.rm(gitdir, { recursive: true });
    const changeOrigin = () =>
      requireGit(repo, ["remote", "set-url", "origin", path.join(root, "different-origin.git")]);
    if (phase === "before cleanup") {
      await changeOrigin();
    } else {
      const withAllocation = allocation.withWorktreeAllocationLease;
      vi.spyOn(allocation, "withWorktreeAllocationLease").mockImplementationOnce(
        async (params, run) => {
          await changeOrigin();
          return await withAllocation(params, run);
        },
      );
    }
    const result = await new ManagedWorktreeService({ env, now: () => now }).gc({ limits: {} });
    expect(result).toMatchObject({ orphansRetired: 0, outcome });
    expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(record!.path, "README.md"), "utf8")).toBe("base\n");
  },
);

it.each(["gitdir", "checkout"])(
  "preserves projection-only files when the %s disappears",
  async (missing) => {
    const root = tempDirs.make("openclaw-gc-projection-");
    const repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    let now = 1_700_000_000_000;
    const [record] = await materializeManagedWorktreeFixtures({
      env,
      repoRoot: repo,
      stateDir,
      now: now - IDLE_GC_MS - 1,
      ownerKind: "session",
      ownerId: "agent:main:projection",
      names: ["projection"],
    });
    deleteRegistryWorktree(env, record!.id);
    record!.id = randomUUID();
    insertRegistryWorktree(env, record!);
    await bindFixtureRepository(env, repo, [record!.id]);
    const projection = await withLocalWorkspaceProjection(
      {
        worktree: record!,
        env,
        agentId: "main",
        sessionKey: record!.ownerId!,
        sessionId: "projection-session",
        lifecycleRevision: null,
        assertCurrent: () => {
          if (getRegistryWorktree(env, record!.id)?.removedAt !== undefined) {
            throw new Error("Projection owner retired");
          }
        },
      },
      (state) => state.prepare(),
    );
    const uniqueFile = path.join(projection, "projection-only.txt");
    await fs.writeFile(uniqueFile, "unique projection bytes\n");
    await fs.rm(
      missing === "gitdir"
        ? await requireGit(record!.path, ["rev-parse", "--absolute-git-dir"])
        : record!.path,
      { recursive: true },
    );
    const service = new ManagedWorktreeService({ env, now: () => now });
    for (let pass = 0; pass < 2; pass++) {
      const result = await service.gc();
      expect(result).toMatchObject({
        outcome: "deferred",
        orphansRetired: 0,
        snapshotsPruned: 0,
        protectionReasons: { "local-workspace-projection": 1 },
      });
      expect((await service.list()).some((item) => item.id === record!.id)).toBe(true);
      expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
      expect(localWorkspaceStore(env).get(record!.id)?.projection_path).toBe(projection);
      expect(await fs.readFile(uniqueFile, "utf8")).toBe("unique projection bytes\n");
      now += SNAPSHOT_RETENTION_MS + 1;
    }
  },
);
