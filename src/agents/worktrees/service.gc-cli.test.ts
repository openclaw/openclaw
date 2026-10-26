import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { withLocalWorkspaceProjection } from "../../gateway/worker-environments/local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "../../gateway/worker-environments/local-workspace-store.test-support.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as allocation from "./allocation.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import { formatWorktreeGcResult } from "./gc-result.js";
import { requireGit } from "./git.js";
import {
  deleteRegistryWorktree,
  insertRegistryWorktree,
  updateRegistryWorktree,
} from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { resolveRepository } from "./repository-paths.js";
import { admitWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
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
    vi.unstubAllEnvs();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();
let root: string, repo: string, stateDir: string, env: NodeJS.ProcessEnv, now: number;

beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  root = tempDirs.make("openclaw-gc-cli-");
  repo = await initializeRepository(root);
  stateDir = path.join(root, "state");
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  now = Date.now();
});

function fixtures(
  names: string[],
  overrides: Partial<Parameters<typeof materializeManagedWorktreeFixtures>[0]> = {},
) {
  return materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir,
    now: now - IDLE_GC_MS - 1,
    ownerKind: "workboard",
    names,
    ...overrides,
  });
}

function cli() {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({}, {});
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  const program = new Command().name("openclaw");
  registerWorktreesCli(program);
  return {
    output,
    run: async () => {
      try {
        await program.parseAsync(["worktrees", "gc", "--json"], { from: "user" });
        return 0;
      } catch (error) {
        if (!(error instanceof ExitError)) {
          throw error;
        }
        return error.code;
      }
    },
  };
}

async function bindFixtureRepository(ids: string[]) {
  const identity = await resolveRepository(repo);
  for (const id of ids) {
    await updateRegistryWorktree(env, id, {
      repositoryIdentity: { repoRoot: identity.repoRoot, repoFingerprint: identity.fingerprint },
    });
  }
}

async function breakGitdir(name: string, overrides: Parameters<typeof fixtures>[1] = {}) {
  const [record] = await fixtures([name], overrides);
  await bindFixtureRepository([record!.id]);
  await fs.rm(await requireGit(record!.path, ["rev-parse", "--absolute-git-dir"]), {
    recursive: true,
  });
  return record!;
}

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["checkout-parent", "tracked-parent"])(
  "retains an unreadable %s across CLI cleanup sweeps",
  async (blocked) => {
    await fs.mkdir(path.join(repo, "tracked"));
    await fs.writeFile(path.join(repo, "tracked", "file.txt"), "preserve unreadable content\n");
    await requireGit(repo, ["add", "tracked"]);
    await requireGit(repo, ["commit", "-m", "add tracked directory"]);
    const [record] = await fixtures(["unreadable"]);
    const service = new ManagedWorktreeService({ env });
    const gc = service.gc.bind(service);
    const gcSpy = vi.spyOn(ManagedWorktreeService.prototype, "gc").mockImplementation(gc);
    await closeOpenClawStateDatabaseAsync();
    const { output, run } = cli();
    const locked =
      blocked === "checkout-parent"
        ? path.dirname(record!.path)
        : path.join(record!.path, "tracked");
    await fs.chmod(locked, 0o000);
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(await run()).toBe(0);
        expect(output.mock.lastCall?.[0]).toMatchObject({
          outcome: "deferred",
          removed: [],
          orphansRetired: 0,
          protectedCount: 1,
          failedCount: 0,
          protectionReasons: { unreadable: 1 },
          issues: [
            {
              id: record!.id,
              stage: "idle",
              outcome: "deferred",
              reason: expect.stringContaining(locked),
            },
          ],
        });
      }
      expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
    } finally {
      gcSpy.mockRestore();
      await fs.chmod(locked, 0o755);
    }
    expect((await service.gc()).removed).toEqual([record!.id]);
  },
);

it("finishes CLI cleanup across moved HEADs, orphans, idle, active, leased and manual records", async () => {
  const records = await fixtures(["moved", "orphan", "idle"]);
  const [moved, orphan, idle] = records;
  await bindFixtureRepository(records.map((record) => record.id));
  await requireGit(moved!.path, ["checkout", "--detach"]);
  const gitdir = await requireGit(orphan!.path, ["rev-parse", "--absolute-git-dir"]);
  await fs.rm(gitdir, { recursive: true });
  await fs.writeFile(path.join(orphan!.path, "local.txt"), "preserve uncertain checkout files\n");
  // Protected metadata has no managed checkout: protection must precede Git inspection.
  const protectedRecords = ["active", "leased", "manual"].map((name) =>
    Object.assign({}, moved!, {
      id: name,
      name,
      path: repo,
      ownerKind: name === "manual" ? ("manual" as const) : ("workboard" as const),
      ownerId: name === "active" ? "active-owner" : name,
    }),
  );
  for (const record of protectedRecords) {
    await insertRegistryWorktree(env, record);
  }
  const [, leased, manual] = protectedRecords;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const [record, pid] of [
        [leased!, process.pid],
        [idle!, 2_147_483_647],
      ] as const) {
        admitWorktreeRunLeaseInDatabase(db, {
          worktreeId: record.id,
          token: record.id,
          pid,
          startTime: null,
          now,
        });
      }
    },
    { env },
  );
  const service = new ManagedWorktreeService({ env });
  const gc = service.gc.bind(service);
  const ownerPolicy: WorktreeCleanupOwnerPolicy = {
    readOwnerState: (_kind, id) => (id === "active-owner" ? "active" : "idle"),
  };
  let collected: ManagedWorktreeGcResult | undefined;
  vi.spyOn(ManagedWorktreeService.prototype, "gc").mockImplementation(async (params) => {
    collected = await gc({
      ...params,
      ...ownerPolicy,
      prepareOwners: async () => ownerPolicy,
    });
    return collected;
  });
  await closeOpenClawStateDatabaseAsync();
  const { output, run } = cli();
  expect(await run()).toBe(0);
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "deferred",
      removed: [idle!.id],
      orphansRetired: 1,
      retiredCheckoutPaths: [orphan!.path],
      eligibleCount: 1,
      deferredCount: 3,
      failedCount: 0,
      protectedCount: 3,
      protectionReasons: {
        "owner is active": 1,
        "run lease is active": 1,
        "branch-moved": 1,
      },
    }),
  );
  if (!collected) {
    throw new Error("CLI cleanup did not return its result");
  }
  expect(formatWorktreeGcResult(collected)).toContain(orphan!.path);
  expect(getRegistryWorktree(env, orphan!.id)?.removedAt).toBeGreaterThanOrEqual(now);
  expect(getRegistryWorktree(env, orphan!.id)?.removedAt).toBeLessThanOrEqual(Date.now());
  expect((await service.list()).some((record) => record.id === orphan!.id)).toBe(false);
  await expect(service.restore({ id: orphan!.id })).rejects.toThrow("is not restorable");
  expect(await requireGit(repo, ["rev-parse", "--verify", orphan!.branch])).toBeTruthy();
  expect(getRegistryWorktree(env, moved!.id)?.removedAt).toBeUndefined();
  expect(await requireGit(repo, ["rev-parse", "--verify", moved!.branch])).toBeTruthy();
  expect(await fs.readFile(path.join(orphan!.path, "local.txt"), "utf8")).toBe(
    "preserve uncertain checkout files\n",
  );
  expect(getRegistryWorktree(env, idle!.id)?.snapshotRef).toBeTruthy();
  await expect(fs.stat(idle!.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(getRegistryWorktree(env, manual!.id)?.removedAt).toBeUndefined();
});

it("preserves a recent orphan when its owner becomes live during cleanup", async () => {
  const record = await breakGitdir("recent-orphan", { now, ownerId: "revived-owner" });
  const service = new ManagedWorktreeService({ env });
  const result = await service.gc({
    readOwnerState: vi.fn().mockReturnValueOnce("retired").mockReturnValue("idle"),
  });
  expect(result).toMatchObject({ removed: [], orphansRetired: 0, outcome: "deferred" });
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});

it.each([
  { phase: "before cleanup", outcome: "partial" },
  { phase: "after the initial probe", outcome: "deferred" },
])(
  "preserves a broken-link record when its source origin changes $phase",
  async ({ phase, outcome }) => {
    const record = await breakGitdir("changed-origin");
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
    const result = await new ManagedWorktreeService({ env }).gc();
    expect(result).toMatchObject({ orphansRetired: 0, outcome });
    expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
  },
);

it.each(["gitdir", "checkout"])(
  "preserves projection-only files when the %s disappears",
  async (missing) => {
    const [record] = await fixtures(["projection"], {
      ownerKind: "session",
      ownerId: "agent:main:projection",
    });
    await deleteRegistryWorktree(env, record!.id);
    record!.id = randomUUID();
    await insertRegistryWorktree(env, record!);
    await bindFixtureRepository([record!.id]);
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
    const service = new ManagedWorktreeService({ env });
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
      expect((await readLocalWorkspaceProjection(record!.id, env))?.projection_path).toBe(
        projection,
      );
      expect(await fs.readFile(uniqueFile, "utf8")).toBe("unique projection bytes\n");
    }
  },
);
