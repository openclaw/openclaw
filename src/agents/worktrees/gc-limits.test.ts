import { beforeEach, expect, it, vi } from "vitest";
import { enforceWorktreeCleanupLimits, worktreeCapacityError } from "./gc-limits.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import type { ManagedWorktreeRecord } from "./types.js";

const inventory = vi.hoisted(() => ({ records: [] as ManagedWorktreeRecord[] }));
// mock-isolation: Rank synthetic inventories without admitting a state database or worker.
vi.mock("./registry-read.js", () => ({
  readRegistryWorktrees: async () => inventory.records,
  readLiveRegistryWorktreeIds: async () => inventory.records.map((item) => item.id),
}));

function record(
  id: string,
  lastActiveAt: number,
  ownerKind: ManagedWorktreeRecord["ownerKind"] = "session",
): ManagedWorktreeRecord {
  return {
    id,
    name: id,
    repoFingerprint: "repository",
    repoRoot: "/source",
    path: `/worktrees/${id}`,
    branch: `openclaw/${id}`,
    baseRef: "main",
    ownerKind,
    ownerId: `owner-${id}`,
    createdAt: 0,
    lastActiveAt,
  };
}

beforeEach(() => {
  inventory.records = [];
});

const repositories = async () => [{ repoRoot: "/source", commonDir: "/source/.git" }];

it("evicts merged, cumulative squash, then oldest protected manual work, retaining live owners", async () => {
  inventory.records = [
    record("live", 0),
    { ...record("dirty-manual", 1, "manual"), gcProtection: "nested repository" },
    record("squashed", 2),
    record("merged", 3),
  ];
  const progress = new WorktreeGcProgress();
  const evictions: string[] = [];
  const removed = await enforceWorktreeCleanupLimits({
    env: {},
    maxCount: 0,
    progress,
    repositories,
    hasLiveLease: (item) => item.id === "live",
    classify: async () => [
      { id: "squashed", reason: "squashed" },
      { id: "merged", reason: "merged" },
    ],
    evict: async (item, reason) => {
      evictions.push(`${item.id}:${reason}`);
      inventory.records = inventory.records.filter((entry) => entry.id !== item.id);
    },
    onError: async (_item, error) => {
      throw error;
    },
  });
  expect(evictions).toEqual(["merged:merged", "squashed:squashed", "dirty-manual:idle-age"]);
  expect(removed).toEqual(["merged", "squashed", "dirty-manual"]);
  expect(progress.result).toMatchObject({
    limitsSatisfied: false,
    protectionReasons: { "live-refused": 1 },
  });
  expect(worktreeCapacityError(3, inventory.records).message).toMatch(
    /cap 3.*owner-live.*worktreeMaxCount/,
  );
});

it("does no Git classification below the cap and stops after freeing the requested slot", async () => {
  inventory.records = [record("old", 1), record("new", 2)];
  const classify = vi.fn(async () => []);
  const evict = vi.fn(async (item: ManagedWorktreeRecord) => {
    inventory.records = inventory.records.filter((entry) => entry.id !== item.id);
  });
  const params = {
    env: {},
    progress: new WorktreeGcProgress(),
    repositories,
    hasLiveLease: () => false,
    classify,
    evict,
    onError: async (_item: ManagedWorktreeRecord, error: unknown) => {
      throw error;
    },
  };
  await enforceWorktreeCleanupLimits({ ...params, maxCount: 2 });
  expect(classify).not.toHaveBeenCalled();
  expect(evict).not.toHaveBeenCalled();
  expect(await enforceWorktreeCleanupLimits({ ...params, maxCount: 1 })).toEqual(["old"]);
  expect(inventory.records.map((item) => item.id)).toEqual(["new"]);
  expect(params.progress.result.limitsSatisfied).toBe(true);
});

it("does not repeat a failed victim while draining later batches", async () => {
  inventory.records = [record("blocked", 0), record("first", 1), record("second", 2)];
  const progress = new WorktreeGcProgress();
  const failures = vi.fn(async () => {});
  const attempts: string[] = [];
  const batch = async () => {
    let removed = 0;
    return await enforceWorktreeCleanupLimits({
      env: {},
      maxCount: 0,
      progress,
      repositories,
      hasLiveLease: () => false,
      classify: async () => [],
      shouldYield: () => removed >= 1,
      evict: async (item) => {
        attempts.push(item.id);
        if (item.id === "blocked") {
          throw new Error("synthetic removal failure");
        }
        inventory.records = inventory.records.filter((entry) => entry.id !== item.id);
        removed += 1;
      },
      onError: failures,
    });
  };
  expect(await batch()).toEqual(["first"]);
  expect(await batch()).toEqual(["second"]);
  expect(await batch()).toEqual([]);
  expect(attempts).toEqual(["blocked", "first", "second"]);
  expect(failures).toHaveBeenCalledTimes(1);
  expect(progress.result.limitsSatisfied).toBe(false);
});

it("keeps unreadable idle repositories eligible instead of inventing mutual dependencies", async () => {
  inventory.records = [record("unreadable-first", 1), record("unreadable-second", 2)];
  const progress = new WorktreeGcProgress();
  expect(
    await enforceWorktreeCleanupLimits({
      env: {},
      maxCount: 0,
      progress,
      repositories: async () => [{ repoRoot: "/source" }],
      hasLiveLease: () => false,
      classify: async () => [],
      evict: async (item) => {
        inventory.records = inventory.records.filter((entry) => entry.id !== item.id);
      },
      onError: async (_item, error) => {
        throw error;
      },
    }),
  ).toEqual(["unreadable-first", "unreadable-second"]);
  expect(progress.result.limitsSatisfied).toBe(true);
});
