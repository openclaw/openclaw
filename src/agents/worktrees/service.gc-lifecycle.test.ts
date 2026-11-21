import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import * as gitBudget from "../../infra/git-content-budget.js";
import * as gitExec from "../../infra/git-exec.js";
import {
  isSessionMutationActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  removeSessionWorktree,
  restoreSessionWorktree,
} from "../../sessions/session-worktree-lifecycle.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit } from "./git.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import * as registryReads from "./registry-read.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import * as removal from "./removal-git.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { ManagedWorktreeService, WORKTREE_GC_INTERVAL_MS } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import * as snapshots from "./snapshot-host.js";

// mock-isolation: This local checkout has no remote worker placements.
vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: () => new Map(),
      listAsync: async () => [],
      prepareMaintenancePlacements: async () => ({
        placements: [],
        assertCurrent: () => {},
        release: () => {},
      }),
      prepareSessionPlacement: async () => ({
        prepareRead: () => undefined,
        current: () => undefined,
        release: () => {},
      }),
    },
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();

async function archivedSession(name: string) {
  const root = tempDirs.make("openclaw-worktree-cleanup-lifecycle-");
  const repoRoot = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionKey = `agent:main:${name}-worktree`;
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name,
    now: 1,
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const entry: SessionEntry = {
    sessionId: `${name}-session`,
    updatedAt: 1,
    archivedAt: 1,
    worktree: { id: record.id, branch: record.branch, repoRoot },
  };
  const scope = { sessionKey, storePath, env };
  await replaceSessionEntry({ agentId: "main", ...scope }, entry);
  return { repoRoot, env, sessionKey, storePath, cfg, record, entry, scope };
}

it("releases session mutation admission during Git while the registry claim fences consumers", async ({
  signal,
}) => {
  const { repoRoot, env, sessionKey, storePath, cfg, record, entry, scope } =
    await archivedSession("archived");
  await fs.writeFile(path.join(record.path, "draft.txt"), "preserved draft\n");
  const service = new ManagedWorktreeService({ env });
  const entered = createDeferred();
  const release = createDeferred();
  const checkoutRemoved = createDeferred();
  const publishRemoval = createDeferred();
  const capture = snapshots.captureManagedWorktreeSnapshot;
  vi.spyOn(snapshots, "captureManagedWorktreeSnapshot").mockImplementationOnce(async (params) => {
    entered.resolve();
    await release.promise;
    return await capture(params);
  });
  const removeCheckout = removal.removeManagedCheckout;
  vi.spyOn(removal, "removeManagedCheckout").mockImplementationOnce(async (...params) => {
    await removeCheckout(...params);
    checkoutRemoved.resolve();
    await publishRemoval.promise;
  });
  const cleanupStarted = Date.now();
  const cleanup = service.gc({
    ...createManagedWorktreeOwnerPolicy(cfg),
    signal,
  });
  void cleanup.catch(() => {});
  const waitForStage = (gate: Promise<void>, stage: string) =>
    withinTest(awaitGateBeforeSettlement(gate, cleanup, `Cleanup settled before ${stage}`), signal);
  const identities = [sessionKey, entry.sessionId];
  try {
    await waitForStage(entered.promise, "snapshot capture");
    expect(isSessionMutationActive(storePath, identities)).toBe(false);
    await expect(acquireWorktreeRunLease(record.id, { env })).rejects.toThrow(/remov/i);
    await runSessionMutation({
      policy: "wait",
      scope: storePath,
      identities,
      run: async () => {
        await expect(restoreSessionWorktree({ entry, scope })).rejects.toMatchObject({
          reason: "busy",
        });
        // A session delete cannot hold this fence while waiting on the remover's checkout lease.
        await expect(service.remove({ id: record.id, reason: "session-delete" })).rejects.toThrow(
          /removal is in progress/i,
        );
      },
    });
    release.resolve();
    await waitForStage(checkoutRemoved.promise, "checkout removal");
    await runSessionMutation({
      kind: "delete",
      policy: "wait",
      scope: storePath,
      identities,
      run: async () => {
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath,
          env,
          archiveTranscript: false,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
        await expect(
          removeSessionWorktree({
            id: record.id,
            sessionKey,
            reason: "session-delete",
            env,
          }),
        ).resolves.toMatchObject({ id: record.id, reason: "busy" });
      },
    });
  } finally {
    release.resolve();
    publishRemoval.resolve();
    await cleanup;
  }
  expect((await cleanup).removed).toEqual([record.id]);
  expect(isSessionMutationActive(storePath, identities)).toBe(false);
  const removed = getRegistryWorktree(env, record.id)!;
  expect(removed.removedAt).toBeGreaterThanOrEqual(cleanupStarted);
  expect(removed.removedAt).toBeLessThanOrEqual(Date.now());
  expect(await requireGit(repoRoot, ["show", `${removed.snapshotRef}:draft.txt`])).toBe(
    "preserved draft",
  );
});

it("refuses unarchive after an interrupted removal releases its process claim", async () => {
  const { repoRoot, env, record, entry, scope } = await archivedSession("partial");
  await requireGit(repoRoot, ["update-ref", `refs/openclaw/removals/${record.id}`, "HEAD"]);
  await expect(restoreSessionWorktree({ entry, scope })).rejects.toThrow(/removal is incomplete/i);
  expect(entry.archivedAt).toBe(1);
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});

it("records failed deleted-session cleanup and replaces it only after preserving the snapshot", async () => {
  const { repoRoot, env, sessionKey, storePath, cfg, record } =
    await archivedSession("deleted-cleanup");
  await fs.writeFile(path.join(record.path, "draft.txt"), "recoverable deleted-session work\n");
  await deleteSessionEntryLifecycle({
    agentId: "main",
    storePath,
    env,
    archiveTranscript: false,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });
  const service = new ManagedWorktreeService({ env });
  const capture = vi
    .spyOn(snapshots, "captureManagedWorktreeSnapshot")
    .mockRejectedValueOnce(new Error("snapshot storage unavailable"));
  const failed = await service.gc(createManagedWorktreeOwnerPolicy(cfg));
  expect(failed.removed).not.toContain(record.id);
  expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe(
    "recoverable deleted-session work\n",
  );
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const retained = (await service.listRegistryRecords()).find((entry) => entry.id === record.id);
  expect(retained).toMatchObject({
    runEndCleanup: {
      outcome: "failed",
      reason: expect.stringContaining("snapshot storage unavailable"),
    },
  });
  expect(retained?.removedAt).toBeUndefined();
  capture.mockRestore();

  expect((await service.gc(createManagedWorktreeOwnerPolicy(cfg))).removed).toContain(record.id);
  const removed = (await service.listRegistryRecords()).find((entry) => entry.id === record.id)!;
  expect(removed).toMatchObject({
    removedAt: expect.any(Number),
    runEndCleanup: { outcome: "removed-lossless" },
  });
  expect(removed.runEndCleanup?.reason).toBeUndefined();
  await expect(fs.access(record.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await requireGit(repoRoot, ["show", `${removed.snapshotRef}:draft.txt`])).toBe(
    "recoverable deleted-session work",
  );
});

it("continues cleanup when a failed snapshot's session was deleted before outcome recording", async () => {
  const { repoRoot, env, sessionKey, storePath, cfg, record } =
    await archivedSession("changed-cleanup-owner");
  const nextKey = `${sessionKey}-next`;
  const next = await materializeManagedWorktreeFixture({
    env,
    stateDir: env.OPENCLAW_STATE_DIR,
    repoRoot,
    name: "next-cleanup-owner",
    now: 0,
    ownerKind: "session",
    ownerId: nextKey,
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: nextKey, storePath, env },
    {
      sessionId: "next-cleanup-session",
      updatedAt: 1,
      archivedAt: 1,
      worktree: { id: next.id, branch: next.branch, repoRoot },
    },
  );
  await fs.writeFile(path.join(record.path, "draft.txt"), "preserve the failed checkout\n");
  await fs.writeFile(path.join(next.path, "draft.txt"), "snapshot the next checkout\n");
  const capture = snapshots.captureManagedWorktreeSnapshot;
  const captured: string[] = [];
  vi.spyOn(snapshots, "captureManagedWorktreeSnapshot").mockImplementation(async (params) => {
    captured.push(params.record.id);
    if (params.record.id === record.id) {
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        env,
        archiveTranscript: false,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      throw new Error("snapshot failed after owner deletion");
    }
    return capture(params);
  });
  const service = new ManagedWorktreeService({ env });
  const result = await service.gc(createManagedWorktreeOwnerPolicy(cfg));
  expect(captured).toEqual([record.id, next.id]);
  expect(result.removed).toEqual([next.id]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ id: record.id, reason: expect.stringContaining("snapshot failed") }),
  );
  expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe(
    "preserve the failed checkout\n",
  );
  const records = await service.listRegistryRecords();
  expect(records.find((entry) => entry.id === record.id)?.runEndCleanup).toBeUndefined();
  const removed = records.find((entry) => entry.id === next.id)!;
  expect(await requireGit(repoRoot, ["show", `${removed.snapshotRef}:draft.txt`])).toBe(
    "snapshot the next checkout",
  );
});

it(
  "lets admitted content writers publish refs while pack maintenance waits for a slot",
  { timeout: 5_000 },
  async ({ signal }) => {
    const root = tempDirs.make("worktree-maintenance-content-admission-");
    const repoRoot = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    setRuntimeConfigSnapshot({});
    await materializeManagedWorktreeFixture({
      env,
      stateDir: root,
      repoRoot,
      name: "publication",
      now: 1,
    });
    await requireGit(repoRoot, ["repack", "-d"]);
    const head = await requireGit(repoRoot, ["rev-parse", "HEAD"]);
    const refs = ["refs/openclaw/test-publication/one", "refs/openclaw/test-publication/two"];
    const abort = new AbortController();
    const occupied = createDeferred();
    const publish = createDeferred();
    const maintenanceWaiting = createDeferred();
    const withSlot = gitBudget.withContentGitSlot;
    let observeWait = false;
    vi.spyOn(gitBudget, "withContentGitSlot").mockImplementation(
      (run, queueSignal, interactive) => {
        const pending = withSlot(run, queueSignal, interactive);
        if (observeWait) {
          maintenanceWaiting.resolve();
        }
        return pending;
      },
    );
    let writers: Promise<string>[] = [];
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (options?.operation === "worktree.maintenance" && args[1] === "--git-common-dir") {
        let active = 0;
        // Fill the budget after maintenance's metadata read. Snapshot workers also
        // hold a content slot while publishing through the real shared ref queue.
        writers = refs.map((ref) =>
          withSlot(async () => {
            if (++active === refs.length) {
              occupied.resolve();
            }
            await publish.promise;
            return requireGit(repoRoot, ["update-ref", ref, head], { signal: abort.signal });
          }, abort.signal),
        );
        for (const writer of writers) {
          void writer.catch(() => {});
        }
        await occupied.promise;
        observeWait = true;
      }
      return result;
    });
    const maintenance = createWorktreeGitMaintenance(env)({ signal: abort.signal });
    void maintenance.catch(() => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          maintenanceWaiting.promise,
          maintenance,
          "Maintenance settled before waiting for content admission",
        ),
        signal,
      );
      publish.resolve();
      await withinTest(Promise.all([...writers, maintenance]), signal);
      for (const ref of refs) {
        expect(await requireGit(repoRoot, ["rev-parse", ref])).toBe(head);
      }
    } finally {
      abort.abort(new Error("content admission test finished"));
      publish.resolve();
      await Promise.allSettled([...writers, maintenance]);
    }
  },
);

it("bounds Git housekeeping without delaying orphan cleanup or newly registered repositories", async () => {
  const root = tempDirs.make("worktree-gc-cadence-state-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  setRuntimeConfigSnapshot({});
  const repo = await initializeRepository(tempDirs.make("worktree-gc-cadence-"));
  const seed = (repoRoot: string, names: string[], now = 1) =>
    materializeManagedWorktreeFixtures({ env, repoRoot, stateDir: repoRoot, names, now });
  await seed(repo, ["first", "second", "third"]);
  const service = new ManagedWorktreeService({ env });
  const commands = vi.spyOn(gitExec, "executeGitCommand");
  const expectMaintenance = (...roots: string[]) => {
    const calls = commands.mock.calls.filter(
      (call) => call[2]?.operation === "worktree.maintenance",
    );
    expect(new Set(calls.map(([cwd]) => cwd))).toEqual(new Set(roots));
    commands.mockClear();
  };
  await service.gc();
  expectMaintenance(repo);

  const orphan = path.join(env.OPENCLAW_STATE_DIR, "worktrees", "unregistered", "empty");
  await fs.mkdir(orphan, { recursive: true });
  expect(await service.gc()).toMatchObject({ orphansDeleted: 1, outcome: "completed" });
  await expect(fs.access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  expectMaintenance();

  const otherRepo = await initializeRepository(tempDirs.make("worktree-gc-new-repo-"));
  await seed(otherRepo, ["new-repo"], Date.now());
  await service.gc();
  expectMaintenance(otherRepo);

  await service.gc({ retryDeferred: true });
  expectMaintenance(repo, otherRepo);
  await service.gc();
  expectMaintenance();

  const records = await registryReads.readRegistryWorktrees(env);
  await closeOpenClawStateDatabaseAsync();
  const inventory = vi.spyOn(registryReads, "readRegistryWorktrees").mockResolvedValue(records);
  // Keep the cadence clock behind the lease worker's real clock throughout the test.
  let now = Date.now() - WORKTREE_GC_INTERVAL_MS;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const maintain = createWorktreeGitMaintenance(env);
    await maintain({});
    expectMaintenance(repo, otherRepo);
    now += WORKTREE_GC_INTERVAL_MS - 1;
    await maintain({});
    expectMaintenance();
    now += 1;
    await maintain({});
    expectMaintenance(repo, otherRepo);
  } finally {
    clock.mockRestore();
    inventory.mockRestore();
  }
});
