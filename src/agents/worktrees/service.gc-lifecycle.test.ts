import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  removeSessionWorktree,
  restoreSessionWorktree,
} from "../../sessions/session-worktree-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import * as removal from "./removal-git.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import * as snapshots from "./snapshot-host.js";

const session = vi.hoisted(() => ({ entry: undefined as SessionEntry | undefined }));
// mock-isolation: Session metadata is synthetic; checkout claims and lifecycle admission stay real.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: () => session.entry,
  loadSessionEntryReadOnly: async () => session.entry,
  resolveSessionEntryAccessTarget: ({ sessionKey }: { sessionKey: string }) => ({
    agentId: "main",
    canonicalKey: sessionKey,
    entry: session.entry,
  }),
}));
// mock-isolation: Owner metadata stays synthetic while checkout claims and lifecycle admission stay real.
vi.mock("../../config/sessions/session-accessor.entry.js", () => ({
  resolveSessionEntryAccessTarget: ({ sessionKey }: { sessionKey: string }) => ({
    agentId: "main",
    canonicalKey: sessionKey,
    entry: session.entry,
  }),
  readResolvedSessionEntriesInWorker: async ({ sessionKeys }: { sessionKeys: string[] }) =>
    new Map(
      sessionKeys.map((sessionKey) => [
        sessionKey,
        {
          agentId: "main",
          canonicalKey: sessionKey,
          entry: session.entry,
        },
      ]),
    ),
}));
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
      prepareSessionPlacement: async () => ({ current: () => undefined, release: () => {} }),
    },
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    session.entry = undefined;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "archived",
    now: 1,
    ownerKind: "session",
    ownerId: sessionKey,
  });
  session.entry = {
    sessionId: "archived-session",
    updatedAt: 1,
    archivedAt: 1,
    worktree: { id: record.id, branch: record.branch, repoRoot },
  };
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
    ...createManagedWorktreeOwnerPolicy({ session: { store: storePath } }),
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
  const identities = [sessionKey, session.entry.sessionId];
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
            entry: session.entry!,
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
        session.entry = undefined;
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
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "partial",
    now: 1,
    ownerKind: "session",
    ownerId: sessionKey,
  });
  session.entry = {
    sessionId: "partial-session",
    updatedAt: 1,
    archivedAt: 1,
    worktree: { id: record.id, branch: record.branch, repoRoot },
  };
  await requireGit(repoRoot, ["update-ref", `refs/openclaw/removals/${record.id}`, "HEAD"]);
  await expect(
    restoreSessionWorktree({
      entry: session.entry,
      scope: { sessionKey, storePath, env },
    }),
  ).rejects.toThrow(/removal is incomplete/i);
  expect(session.entry.archivedAt).toBe(1);
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});
