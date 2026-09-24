import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import * as checkoutInspection from "./checkout-inspection.js";
import * as registry from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";
import { hasTemplates } from "./template-registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function addLeasedWorktree(env: NodeJS.ProcessEnv, root: string, id: string) {
  registry.insertRegistryWorktree(env, {
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
  registry.admitWorktreeRunLeaseRow(env, {
    worktreeId: id,
    token: id,
    pid: process.pid,
    startTime: null,
    now: 1,
  });
}

it("protects a sweep of live leases without writer admission or checkout inspection", async () => {
  const root = tempDirs.make("openclaw-gc-leases-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const count = 16;
  for (let index = 0; index < count; index++) {
    const id = `leased-${index}`;
    addLeasedWorktree(env, root, id);
  }
  hasTemplates(env);
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  const lists = vi.spyOn(registry, "listRegistryWorktrees");
  const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
  const cleanupReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
  // Warm the retained reader before measuring steady-state cleanup.
  await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc({ limits: {} });
  writes.mockClear();
  lists.mockClear();
  reads.mockClear();
  cleanupReads.mockClear();
  inspections.mockClear();
  const started = performance.now();
  const result = await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc({
    limits: {},
  });
  const measurements = {
    records: count,
    writes: writes.mock.calls.length,
    registryReads:
      cleanupReads.mock.calls.filter(([, command]) => command.type === "worktrees.cleanupState")
        .length +
      lists.mock.calls.length +
      reads.mock.calls.filter(([, command]) => command.type === "worktrees.list").length,
    checkoutInspections: inspections.mock.calls.length,
    elapsedMs: performance.now() - started,
    rssBytes: process.memoryUsage().rss,
  };
  console.log(JSON.stringify(measurements));
  expect(result.removed).toEqual([]);
  expect(result.protectedCount).toBe(count);
  expect(result.issues.every((issue) => issue.reason === "run lease is active")).toBe(true);
  expect(measurements).toMatchObject({ writes: 0, registryReads: 1, checkoutInspections: 0 });
});

it("protects a leased worktree created after the sweep snapshot before checkout inspection", async () => {
  const root = tempDirs.make("openclaw-gc-late-lease-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  // Pressure reconciliation needs real repository refs, even for protected rows.
  const repo = await initializeManagedWorktreeTestRepository(root);
  addLeasedWorktree(env, repo, "initial");
  const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
  const result = await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc({
    limits: { maxCount: 0 },
    shouldRemoveOwner: () => {
      addLeasedWorktree(env, repo, "late");
      return false;
    },
  });
  expect(result.removed).toEqual([]);
  expect(result.protectedCount).toBe(2);
  expect(result.limitsSatisfied).toBe(false);
  expect(result.issues.every((issue) => issue.reason === "run lease is active")).toBe(true);
  expect(inspections).not.toHaveBeenCalled();
});
