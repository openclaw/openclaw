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
import * as gitExec from "../../infra/git-exec.js";
import {
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  removeSessionWorktree,
  restoreSessionWorktree,
} from "../../sessions/session-worktree-lifecycle.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
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

it("releases session mutation admission during Git while the registry claim fences consumers", async ({
  signal,
}) => {
  const root = tempDirs.make("openclaw-worktree-cleanup-lifecycle-");
  const repoRoot = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionKey = "agent:main:archived-worktree";
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "archived",
    now: 1,
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const entry: SessionEntry = {
    sessionId: "archived-session",
    updatedAt: 1,
    archivedAt: 1,
    worktree: { id: record.id, branch: record.branch, repoRoot },
  };
  await replaceSessionEntry({ agentId: "main", sessionKey, storePath, env }, entry);
  await fs.writeFile(path.join(record.path, "draft.txt"), "preserved draft\n");
  const service = new ManagedWorktreeService({ env, now: () => 2 });
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
  const cleanup = service.gc({
    ...createManagedWorktreeOwnerPolicy(cfg),
    signal,
  });
  void cleanup.catch(() => {});
  const waitForStage = (gate: Promise<void>, stage: string) =>
    withinTest(
      awaitGateBeforeSettlement(
        gate,
        cleanup.then((result) => {
          throw new Error(`Cleanup settled before ${stage}: ${JSON.stringify(result)}`);
        }),
        `Cleanup settled before ${stage}`,
      ),
      signal,
    );
  const identities = [sessionKey, entry.sessionId];
  try {
    await waitForStage(entered.promise, "snapshot capture");
    expect(isSessionLifecycleMutationActive(storePath, identities)).toBe(false);
    await expect(acquireWorktreeRunLease(record.id, { env })).rejects.toThrow(/remov/i);
    await runExclusiveSessionLifecycleMutation("restore", {
      scope: storePath,
      identities,
      run: async () => {
        await expect(
          restoreSessionWorktree({
            entry,
            scope: { sessionKey, storePath, env },
          }),
        ).rejects.toMatchObject({ reason: "busy" });
        // A session delete cannot hold this fence while waiting on the remover's checkout lease.
        await expect(service.remove({ id: record.id, reason: "session-delete" })).rejects.toThrow(
          /removal is in progress/i,
        );
      },
    });
    release.resolve();
    await waitForStage(checkoutRemoved.promise, "checkout removal");
    await runExclusiveSessionLifecycleMutation("delete", {
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
  expect(isSessionLifecycleMutationActive(storePath, identities)).toBe(false);
  const removed = getRegistryWorktree(env, record.id)!;
  expect(removed.removedAt).toBe(2);
  expect(await requireGit(repoRoot, ["show", `${removed.snapshotRef}:draft.txt`])).toBe(
    "preserved draft",
  );
});

it("refuses unarchive after an interrupted removal releases its process claim", async () => {
  const root = tempDirs.make("openclaw-worktree-partial-cleanup-");
  const repoRoot = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionKey = "agent:main:partial-worktree";
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "partial",
    now: 1,
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const entry: SessionEntry = {
    sessionId: "partial-session",
    updatedAt: 1,
    archivedAt: 1,
    worktree: { id: record.id, branch: record.branch, repoRoot },
  };
  await replaceSessionEntry({ agentId: "main", sessionKey, storePath, env }, entry);
  await requireGit(repoRoot, ["update-ref", `refs/openclaw/removals/${record.id}`, "HEAD"]);
  await expect(
    restoreSessionWorktree({
      entry,
      scope: { sessionKey, storePath, env },
    }),
  ).rejects.toThrow(/removal is incomplete/i);
  expect(entry.archivedAt).toBe(1);
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});

it("bounds Git housekeeping without delaying orphan cleanup or newly registered repositories", async () => {
  const root = tempDirs.make("worktree-gc-cadence-state-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  setRuntimeConfigSnapshot({});
  const repo = await initializeRepository(tempDirs.make("worktree-gc-cadence-"));
  await materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir: repo,
    names: ["first", "second", "third"],
    now: 1,
  });
  let now = 3;
  const service = new ManagedWorktreeService({ env, now: () => now });
  const commands = vi.spyOn(gitExec, "executeGitCommand");
  const maintenanceRoots = () =>
    commands.mock.calls.flatMap(([cwd, , options]) =>
      options?.operation === "worktree.maintenance" ? [cwd] : [],
    );
  await service.gc();
  expect(maintenanceRoots().length).toBeGreaterThan(0);
  expect(new Set(maintenanceRoots())).toEqual(new Set([repo]));
  commands.mockClear();

  const orphan = path.join(env.OPENCLAW_STATE_DIR, "worktrees", "unregistered", "empty");
  await fs.mkdir(orphan, { recursive: true });
  now += WORKTREE_GC_INTERVAL_MS - 1;
  expect(await service.gc()).toMatchObject({ orphansDeleted: 1, outcome: "completed" });
  await expect(fs.access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  expect(maintenanceRoots()).toEqual([]);

  const otherRepo = await initializeRepository(tempDirs.make("worktree-gc-new-repo-"));
  await materializeManagedWorktreeFixtures({
    env,
    repoRoot: otherRepo,
    stateDir: otherRepo,
    names: ["new-repo"],
    now,
  });
  await service.gc();
  expect(new Set(maintenanceRoots())).toEqual(new Set([otherRepo]));
  commands.mockClear();

  now += 1;
  await service.gc();
  expect(new Set(maintenanceRoots())).toEqual(new Set([repo]));
  commands.mockClear();
  await service.gc({ retryDeferred: true });
  expect(new Set(maintenanceRoots())).toEqual(new Set([repo, otherRepo]));
  commands.mockClear();
  await service.gc();
  expect(maintenanceRoots()).toEqual([]);
});
