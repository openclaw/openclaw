import { beforeEach, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { createWorktreeCapacityOwner } from "./capacity-owner.js";
import { evictManagedWorktree } from "./eviction.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import type { GitWorktreeOperation, WorktreeEvictionReason } from "./git-worktree-operations.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import { makeWorktreeRecord } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const inventory = vi.hoisted(() => ({
  records: new Array<ManagedWorktreeRecord>(),
  live: new Set<string>(),
  reasons: new Map<string, WorktreeEvictionReason>(),
  failures: new Set<string>(),
  evictions: new Array<string>(),
  unreadable: false,
}));
vi.mock("./registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry-read.js")>()),
  readRegistryWorktrees: async () => inventory.records,
  readLiveRegistryWorktreeIds: async () => inventory.records.map((item) => item.id),
  readWorktreeCleanupState: async () => ({
    records: inventory.records,
    leases: {
      liveScopes: [...inventory.live].map(worktreeRunLeaseScope),
      staleScopes: [],
    },
  }),
}));
vi.mock("./pending-slots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending-slots.js")>()),
  readWorktreeSlotCount: async () => inventory.records.length,
  readPendingWorktrees: async () => [],
}));
vi.mock("../../infra/git-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/git-worker.js")>()),
  runGitWorkerOperation: vi.fn(async (operation: GitWorktreeOperation) => {
    if (operation.type === "worktree.eviction-repositories") {
      return operation.input.repoRoots.map((repoRoot) => ({
        repoRoot,
        commonDir: inventory.unreadable ? undefined : "/source/.git",
        heads: {},
      }));
    }
    if (operation.type === "worktree.eviction-classify") {
      return operation.input.records.map(({ id }) => ({
        id,
        reason: inventory.reasons.get(id) ?? "idle-age",
      }));
    }
    throw new Error(`Unexpected Git operation: ${operation.type}`);
  }),
}));
vi.mock("../../gateway/worktree-merged-heads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/worktree-merged-heads.js")>()),
  readKnownWorktreeMergedHeads: async () => [],
}));
vi.mock("./eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./eviction.js")>()),
  evictManagedWorktree: async ({
    record: victim,
    reason,
  }: Parameters<typeof evictManagedWorktree>[0]) => {
    inventory.evictions.push(`${victim.id}:${reason}`);
    if (inventory.failures.has(victim.id)) {
      throw new Error("synthetic removal failure");
    }
    inventory.records = inventory.records.filter((entry) => entry.id !== victim.id);
    return reason;
  },
}));

const tempDirs = useWorktreeStateRoots();
let env: NodeJS.ProcessEnv;

const record = (id: string, lastActiveAt: number) =>
  makeWorktreeRecord("/source", id, {
    path: `/worktrees/${id}`,
    ownerId: `owner-${id}`,
    lastActiveAt,
  });

beforeEach(() => {
  const root = tempDirs.make("openclaw-worktree-capacity-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  inventory.records = [];
  inventory.live.clear();
  inventory.reasons.clear();
  inventory.failures.clear();
  inventory.evictions = [];
  inventory.unreadable = false;
  vi.clearAllMocks();
});

const owner = (maxCount: number) =>
  createWorktreeCapacityOwner({
    env,
    getConfig: () => ({ worktreeMaxCount: maxCount }),
  });

async function cleanup(maxCount: number, progress = new WorktreeGcProgress()) {
  await owner(maxCount).cleanup({
    records: inventory.records,
    hasLiveLease: (id) => inventory.live.has(id),
    progress,
    guard: {},
    checkpoint: async () => {},
  });
  return progress.result;
}

it("evicts merged, cumulative squash, then oldest protected manual work, retaining live owners", async () => {
  inventory.records = [
    record("live", 0),
    { ...record("dirty-manual", 1), ownerKind: "manual", gcProtection: "nested repository" },
    record("squashed", 2),
    record("merged", 3),
  ];
  inventory.live.add("live");
  inventory.reasons.set("squashed", "squashed");
  inventory.reasons.set("merged", "merged");
  expect(await cleanup(0)).toMatchObject({
    removed: ["merged", "squashed", "dirty-manual"],
    limitsSatisfied: false,
    protectionReasons: { "live-refused": 1 },
  });
  await expect(
    withWorktreeAllocationLease({ env }, (guard) => owner(1).admit(guard)),
  ).rejects.toThrow(/cap 1.*owner-live.*worktreeMaxCount/);
});

it("does no Git classification below the cap and stops after freeing the requested slot", async () => {
  inventory.records = [record("old", 1), record("new", 2)];
  const progress = new WorktreeGcProgress();
  await cleanup(2, progress);
  expect(runGitWorkerOperation).not.toHaveBeenCalled();
  expect(inventory.evictions).toEqual([]);
  expect((await cleanup(1, progress)).removed).toEqual(["old"]);
  expect(inventory.records.map((item) => item.id)).toEqual(["new"]);
  expect(progress.result.limitsSatisfied).toBe(true);
});

it("does not repeat a failed victim while draining later allocation batches", async () => {
  const victims = Array.from({ length: 9 }, (_, index) => `victim-${index}`);
  inventory.records = [record("blocked", 0), ...victims.map((id, index) => record(id, index + 1))];
  inventory.failures.add("blocked");
  const result = await cleanup(0);
  expect(inventory.evictions).toEqual(["blocked", ...victims].map((id) => `${id}:idle-age`));
  expect(result).toMatchObject({
    removed: victims,
    failedCount: 1,
    limitsSatisfied: false,
    issues: [
      {
        id: "blocked",
        stage: "limits",
        outcome: "failed",
        reason: expect.stringContaining("synthetic removal failure"),
      },
    ],
  });
});

it("keeps unreadable idle repositories eligible instead of inventing mutual dependencies", async () => {
  inventory.records = [record("unreadable-first", 1), record("unreadable-second", 2)];
  inventory.unreadable = true;
  expect(await cleanup(0)).toMatchObject({
    removed: ["unreadable-first", "unreadable-second"],
    limitsSatisfied: true,
  });
});
