import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createManagedWorktreeOwnerPolicy } from "../agents/worktrees/owner-protection.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  loadSeededTranscriptEvents,
} from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { createArchiveWorktreeFixture } = setupGatewaySessionsWorktreeTestHarness();
const execFileAsync = promisify(execFile);

afterEach(() => drainGlobalSingletonLifecycleState());

async function pendingWorkerCleanup(sessionId: string, key: string) {
  const placements = createWorkerSessionPlacementStore();
  const requested = await placements.startDispatch({ sessionId, sessionKey: key, agentId: "main" });
  const provisioning = await placements.transition({
    sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: requested.generation,
    patch: { environmentId: "worker-cleanup-pending" },
  });
  const failed = await placements.fail({
    sessionId,
    expectedGeneration: provisioning.generation,
    recoveryError: "provider cleanup pending",
  });
  const environment = {
    state: "destroying",
    leaseId: "retained-lease",
    destroyRequestedAtMs: 1,
    attachedSessionIds: [],
  };
  const reclaim = vi.fn(async () => {
    throw new Error("provider cleanup pending");
  });
  const context = {
    workerEnvironmentService: createWorkerInferenceDrainService(
      () => ({ drained: Promise.resolve(), hasWork: () => false, release() {} }),
      { get: () => environment },
    ),
    workerSessionPlacementService: placements,
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  };
  return { placements, failed, environment, reclaim, context };
}

test("failed worker cleanup does not block archive, reopen, or Undo, and retains recoverable work", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const { key, sessionId, storePath, worktree } = fixture;
  const scope = { storePath, sessionKey: key };
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "retained worker work\n");
  const checkpoint = "refs/openclaw/worker-results/archive-cleanup";
  await execFileAsync("git", ["-C", worktree.path, "update-ref", checkpoint, "HEAD"]);
  const checkpointBefore = (
    await execFileAsync("git", ["-C", worktree.path, "rev-parse", checkpoint])
  ).stdout;
  const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
  const {
    placements,
    failed,
    environment,
    reclaim,
    context: initialContext,
  } = await pendingWorkerCleanup(sessionId, key);
  let context = initialContext;
  const patch = (archived: boolean) =>
    directSessionReq(
      "sessions.patch",
      { key, expectedSessionId: sessionId, archived },
      { context },
    );
  expect(await patch(true)).toMatchObject({ ok: true });
  await disposeSessionReadContexts();
  await closeOpenClawAgentDatabasesAsync(path.dirname(storePath));
  closeOpenClawAgentDatabasesForTest(path.dirname(storePath));
  // Reopening uses a fresh projection binding while retaining the same worker services.
  context = { ...context };
  expect(loadSessionEntry(scope)).toMatchObject({
    sessionId,
    archivedAt: expect.any(Number),
    worktree: { id: worktree.id },
  });
  expect(placements.get(sessionId)).toEqual(failed);
  expect(reclaim).not.toHaveBeenCalled();
  const config = (await getGatewayConfigModule()).getRuntimeConfig();
  const policy = createManagedWorktreeOwnerPolicy(config);
  expect(policy.readOwnerState("session", key)).toBe("active");
  expect(await managedWorktrees.gc(policy)).toMatchObject({
    removed: [],
  });
  expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
  const deleted = await directSessionReq(
    "sessions.delete",
    { key, expectedSessionId: sessionId },
    { context },
  );
  expect(deleted.ok).toBe(false);
  expect(reclaim).toHaveBeenCalledOnce();
  const restore = vi.spyOn(ManagedWorktreeService.prototype, "restore");
  try {
    expect(await patch(false)).toMatchObject({ ok: true });
    expect(restore).not.toHaveBeenCalled();
  } finally {
    restore.mockRestore();
  }
  expect(loadSessionEntry(scope)?.archivedAt).toBeUndefined();
  expect(placements.get(sessionId)).toEqual(failed);
  expect(reclaim).toHaveBeenCalledOnce();
  expect(environment).toMatchObject({ state: "destroying", leaseId: "retained-lease" });
  await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
    "retained worker work\n",
  );
  expect((await execFileAsync("git", ["-C", worktree.path, "rev-parse", checkpoint])).stdout).toBe(
    checkpointBefore,
  );
  await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  expect(await patch(true)).toMatchObject({ ok: true });
  environment.state = "destroyed";
  await placements.transition({
    sessionId,
    from: "failed",
    to: "local",
    expectedGeneration: failed.generation,
  });
  const retiredOwner = createManagedWorktreeOwnerPolicy(config);
  await retiredOwner.withOwnerCleanup(getRegistryWorktree(process.env, worktree.id)!, async () => {
    expect(retiredOwner.readOwnerState("session", key)).toBe("retired");
  });
});

test("failed worker cleanup keeps worktree reconstruction blocked until the worker is gone", async () => {
  const { key, sessionId, storePath, worktree, cleanupWorktrees } =
    await createArchiveWorktreeFixture();
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "restore this work\n");
  expect(
    await directSessionReq("sessions.patch", {
      key,
      expectedSessionId: sessionId,
      archived: true,
    }),
  ).toMatchObject({ ok: true });
  await cleanupWorktrees();
  expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(expect.any(Number));
  const { environment, reclaim, context } = await pendingWorkerCleanup(sessionId, key);
  const restore = vi.spyOn(ManagedWorktreeService.prototype, "restore");
  const unarchive = () =>
    directSessionReq(
      "sessions.patch",
      {
        key,
        expectedSessionId: sessionId,
        archived: false,
      },
      { context },
    );
  try {
    expect((await unarchive()).ok).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
    environment.state = "destroyed";
    expect(await unarchive()).toMatchObject({ ok: true });
    expect(restore).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "restore this work\n",
    );
  } finally {
    restore.mockRestore();
  }
});

test("sessions.patchMany commits archive and releases same-session writes before responding and waking cleanup", async ({
  signal,
}) => {
  const { key, sessionId, storePath, worktree, tickWorktreeMaintenance } =
    await createArchiveWorktreeFixture();
  const revision = loadSessionEntry({ storePath, sessionKey: key })?.lifecycleRevision;
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved work\n");
  const effectsEntered = createDeferredCore();
  const releaseEffects = createDeferredCore();
  const cleanupEntered = createDeferredCore();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const originalGc = managedWorktrees.gc.bind(managedWorktrees);
  const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation((params) => {
    cleanupEntered.resolve();
    return originalGc(params);
  });
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  const remove = vi.spyOn(managedWorktrees, "remove").mockImplementation(async (params) => {
    entered.resolve();
    await release.promise;
    return await originalRemove(params);
  });
  const archived = directSessionReq(
    "sessions.patchMany",
    { targets: [{ key, expectedSessionId: sessionId }], patch: { archived: true } },
    {
      context: {
        cron: {
          list: async () => {
            effectsEntered.resolve();
            await releaseEffects.promise;
            return [];
          },
          getDefaultAgentId: () => "main",
        },
      },
    },
  );
  let beforeResponseTick: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        awaitGateBeforeSettlement(
          effectsEntered.promise,
          archived,
          "archive did not reach its committed effects",
        ),
        entered.promise,
        "archive awaited worktree removal before responding",
      ),
      signal,
    );
    expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
      archivedAt: expect.any(Number),
      worktree: { id: worktree.id },
    });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.lifecycleRevision).toBe(revision);
    expect(
      await withinTest(directSessionReq("sessions.patch", { key, label: "Same session" }), signal),
    ).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.label).toBe("Same session");
    await fs.access(worktree.path);

    beforeResponseTick = tickWorktreeMaintenance();
    await withinTest(
      awaitGateBeforeSettlement(
        beforeResponseTick,
        cleanupEntered.promise,
        "worktree cleanup started before the archive response",
      ),
      signal,
    );
    expect(gc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    releaseEffects.resolve();
    expect(await withinTest(archived, signal)).toMatchObject({
      ok: true,
      payload: { outcomes: [{ ok: true }] },
    });
    cleanup = tickWorktreeMaintenance();
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        cleanup,
        "cleanup did not remove the retired worktree",
      ),
      signal,
    );
    release.resolve();
    await cleanup;
    expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.any(String),
    });
    await expect(fs.access(worktree.path)).rejects.toThrow();
  } finally {
    releaseEffects.resolve();
    release.resolve();
    await Promise.allSettled([archived, beforeResponseTick, cleanup]);
    gc.mockRestore();
    remove.mockRestore();
  }
});
