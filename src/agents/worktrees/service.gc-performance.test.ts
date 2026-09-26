import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import * as checkoutInspection from "./checkout-inspection.js";
import { requireGit } from "./git.js";
import * as registry from "./registry.js";
import { resolveRepository } from "./service-preparation.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixtures,
} from "./service.test-support.js";
import { hasTemplates } from "./template-registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

it("does not reinspect unchanged protected and broken checkouts on hourly sweeps", async () => {
  const root = tempDirs.make("openclaw-gc-spawns-");
  const repo = await initializeManagedWorktreeTestRepository(root);
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
    registry.updateRegistryWorktree(env, record.id, {
      repositoryIdentity: {
        repoRoot: repository.repoRoot,
        repoFingerprint: repository.fingerprint,
      },
    });
  }
  for (const record of records.slice(0, 9)) {
    registry.updateRegistryWorktree(env, record.id, { lastActiveAt: 1 });
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
  registry.updateRegistryWorktree(env, records[8]!.id, {
    repositoryIdentity: { repoRoot: missingRepository, repoFingerprint: "missing" },
  });
  const text = vi.spyOn(gitExec, "executeGitCommand");
  const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
  const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
  const measurements = [];
  for (let pass = 0; pass < 2; pass++) {
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
      gitSpawns: text.mock.calls.length + bytes.mock.calls.length + buffered.mock.calls.length,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
    });
    expect(result.removed).toEqual([]);
    for (const record of records) {
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    }
  }
  console.log(JSON.stringify({ records: records.length, measurements }));
  expect(measurements[1]!.gitSpawns).toBe(0);
  expect(
    records
      .slice(0, 9)
      .every((record) => registry.getRegistryWorktree(env, record.id)?.gcProtection),
  ).toBe(true);
  // A managed owner revision reopens only that record, even if it is still idle.
  registry.updateRegistryWorktree(env, records[0]!.id, { lastActiveAt: 2 });
  text.mockClear();
  bytes.mockClear();
  buffered.mockClear();
  await new ManagedWorktreeService({ env, now: () => now }).gc();
  const inspectedPaths = [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls].map(
    ([cwd]) => cwd,
  );
  expect(inspectedPaths).toContain(records[0]!.path);
  expect(inspectedPaths.every((cwd) => cwd === repo || cwd === records[0]!.path)).toBe(true);
  // External repairs have an explicit retry path without changing configuration.
  await fs.rm(path.join(records[0]!.path, "nested"), { recursive: true });
  const explicit = new ManagedWorktreeService({ env, now: () => now });
  vi.spyOn(explicit, "remove").mockRejectedValueOnce(new Error("transient removal failure"));
  expect((await explicit.gc({ retryDeferred: true })).outcome).toBe("partial");
  expect(registry.getRegistryWorktree(env, records[0]!.id)?.gcProtection).toBeUndefined();
  const retried = await new ManagedWorktreeService({ env, now: () => now }).gc();
  expect(retried.removed).toEqual([records[0]!.id]);
  registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: 3 });
  const inspect = checkoutInspection.inspectManagedWorktreeCheckout;
  vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout").mockImplementation(
    async (...args) => {
      const result = await inspect(...args);
      if (args[0].id === records[1]!.id && args[1] === "nested-repository") {
        registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: now });
      }
      return result;
    },
  );
  await new ManagedWorktreeService({ env, now: () => now }).gc();
  expect(registry.getRegistryWorktree(env, records[1]!.id)?.gcProtection).toBeUndefined();
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

it("protects a late lease without loading removed history for cleanup limits", async () => {
  const root = tempDirs.make("openclaw-gc-late-lease-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  addLeasedWorktree(env, root, "initial");
  registry.insertRegistryWorktree(env, {
    ...registry.getRegistryWorktree(env, "initial")!,
    id: "removed-history",
    removedAt: 0,
  });
  const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
  const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
  const result = await new ManagedWorktreeService({ env, now: () => IDLE_GC_MS + 2 }).gc({
    limits: { maxCount: 0 },
    shouldRemoveOwner: () => {
      addLeasedWorktree(env, root, "late");
      return false;
    },
  });
  expect(result.removed).toEqual([]);
  expect(result.protectedCount).toBe(2);
  expect(result.issues.every((issue) => issue.reason === "run lease is active")).toBe(true);
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
