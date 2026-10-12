import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  placementReader,
  workerPlacement,
} from "./server.sessions.archive-lifecycle.test-support.js";
import { disposeSessionReadContexts } from "./session-read-contexts.test-support.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
  LOCAL_PLACEMENT,
} from "./worker-environments/placement-dispatch-coordinator.test-support.js";
import {
  REQUEST,
  seedProvisioningPlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const pendingArchiveCleanups = new Set<() => Promise<void>>();
const sessionKey = "agent:main:archive-placement";
const sessionId = "archive-placement-session";

async function preparePlacement(
  state: Parameters<typeof workerPlacement>[0]["state"],
  archived = false,
) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, archived ? { archivedAt: 1 } : {}) },
  });
  return { storePath, placement: workerPlacement({ sessionId, sessionKey, state }) };
}

function patchPlacement(context: Record<string, unknown>, archived = true) {
  return directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived, expectedSessionId: sessionId },
    { context },
  );
}

afterEach(async () => {
  // Join gated requests even when a runner timeout leaves the test body suspended.
  for (const cleanup of pendingArchiveCleanups) {
    await cleanup();
  }
  pendingArchiveCleanups.clear();
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.patch retries failed cleanup during unrelated dispatch and rejects concurrent archives", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const environmentStore = await createWorkerEnvironmentStore({
    database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } }),
  });
  await environmentStore.createIntent({
    environmentId: "worker-environment",
    providerId: "fixture",
    profileId: "fixture",
    profileSnapshot: {},
    provisionOperationId: "fixture-provision",
  });
  const unexpectedWorkerWork = async (): Promise<never> => {
    throw new Error("Archive fixture must not start provider or inference work");
  };
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: environmentStore,
    getConfig: () => ({}),
    resolveProvider: () => undefined,
    prepareInstallation: unexpectedWorkerWork,
    bootstrapWorker: unexpectedWorkerWork,
  });
  const reclaimStarted = createDeferredCore();
  const releaseReclaim = createDeferredCore();
  const reclaim = vi.fn(async () => {
    reclaimStarted.resolve();
    await releaseReclaim.promise;
    if (reclaim.mock.calls.length === 1) {
      throw new Error("provider cleanup pending");
    }
    const local = { ...LOCAL_PLACEMENT, sessionId, sessionKey };
    placement = local;
    return local;
  });
  const dispatchEntered = createDeferredCore();
  const releaseDispatch = createDeferredCore();
  const reconcile = vi.fn(async () => {});
  const coordinated = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async (request) => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
        return { ...ACTIVE_PLACEMENT, ...request };
      },
      reconcile,
      reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
        if (!serialize) {
          throw new Error("Archive fixture requires reclaim serialization");
        }
        return await serialize(reclaim);
      },
    }),
    (_request, run) => run(),
  );
  const dispatch = coordinated.dispatch({
    ...REQUEST,
    sessionId: "unrelated-session",
    sessionKey: "agent:main:unrelated-session",
  });
  await dispatchEntered.promise;
  const sweep = coordinated.reconcile();
  const context = {
    workerEnvironmentService: environments,
    workerSessionPlacementService: placementReader(() => placement),
    workerPlacementDispatchService: coordinated,
  };
  const archive = () =>
    directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      { context },
    );
  const first = archive();
  try {
    await Promise.race([
      reclaimStarted.promise,
      first.then((result) => {
        expect(result).toMatchObject({ ok: true });
        throw new Error("archive completed before worker cleanup");
      }),
    ]);
    expect(reclaim).toHaveBeenCalledOnce();
    const duplicate = await archive();
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: true,
        message: expect.stringContaining("already being stopped by another archive or delete"),
      },
    });
    expect(reclaim).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    releaseReclaim.resolve();
    expect(await first).toMatchObject({ ok: false });
    expect(await archive()).toMatchObject({ ok: true });
    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    releaseReclaim.resolve();
    releaseDispatch.resolve();
    await Promise.all([first, dispatch, sweep]);
    await environments.stop();
  }
});

test.each([false, true])(
  "sessions.patch waits for orphaned provisioning cleanup (failure=%s)",
  async (destroyFails) => {
    const { dir, storePath } = await createSessionStoreDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } });
    const placements = createWorkerSessionPlacementStore({ database });
    const harness = createHarness(database, placements, { workspacePath: dir, destroyFails });
    await seedProvisioningPlacement(placements, harness.ready.environmentId);
    await writeSessionStore({
      entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
    });
    const destroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
    const destroying = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(harness.environments.destroy).mockImplementation(async (environmentId) => {
      destroying.resolve();
      await release.promise;
      return await destroy(environmentId);
    });
    const archive = directSessionReq(
      "sessions.patch",
      {
        key: REQUEST.sessionKey,
        archived: true,
        expectedSessionId: REQUEST.sessionId,
      },
      {
        context: {
          workerEnvironmentService: createWorkerInferenceDrainService(
            () => ({
              drained: Promise.resolve(),
              hasWork: () => false,
              release: vi.fn(),
            }),
            harness.environments,
          ),
          workerSessionPlacementService: placements,
          workerPlacementDispatchService: harness.service,
        },
      },
    );
    try {
      await Promise.race([
        destroying.promise,
        archive.then((result) => {
          expect(result).toMatchObject({ ok: true });
          throw new Error("archive completed before worker destruction");
        }),
      ]);
      expect(
        loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey })?.archivedAt,
      ).toBeUndefined();
      release.resolve();
      if (destroyFails) {
        await expect(archive).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
        expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
        expect(harness.environments.get(harness.ready.environmentId)?.state).not.toBe("destroyed");
        expect(
          loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey })?.archivedAt,
        ).toBeUndefined();
        return;
      }
      await expect(archive).resolves.toMatchObject({ ok: true });
      expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
      expect(harness.environments.get(harness.ready.environmentId)?.state).toBe("destroyed");
      expect(loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey })?.archivedAt).toEqual(
        expect.any(Number),
      );
    } finally {
      release.resolve();
      await archive;
    }
  },
);

test.each(["rejected", "unavailable"] as const)(
  "sessions.patch leaves active placement unarchived and releases its drain when reclaim is %s",
  async (failure) => {
    const { storePath, placement } = await preparePlacement("active");
    const release = vi.fn();
    const reclaim = vi.fn(async () => {
      throw new Error("provider reclaim rejected");
    });
    const workerPlacementDispatchService =
      failure === "rejected" ? { dispatch: vi.fn(), reclaim } : { dispatch: vi.fn() };

    const archived = await patchPlacement({
      workerEnvironmentService: createWorkerInferenceDrainService(() => ({
        drained: Promise.resolve(),
        hasWork: () => false,
        release,
      })),
      workerSessionPlacementService: placementReader(() => placement),
      workerPlacementDispatchService,
    });

    expect(archived).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(reclaim).toHaveBeenCalledTimes(failure === "rejected" ? 1 : 0);
  },
);

test("sessions.patch rejects a mismatched reclaimed identity without archiving", async () => {
  const { storePath, placement } = await preparePlacement("active");
  const reclaim = vi.fn(async () =>
    workerPlacement({
      sessionId,
      sessionKey: "agent:main:wrong-session",
      state: "reclaimed",
    }),
  );

  const archived = await patchPlacement({
    workerSessionPlacementService: placementReader(() => placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  });

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rejects a reclaimed return when its authoritative placement stayed active", async () => {
  const { storePath, placement } = await preparePlacement("active");
  const reclaim = vi.fn(async () => workerPlacement({ sessionId, sessionKey, state: "reclaimed" }));

  const archived = await patchPlacement({
    workerSessionPlacementService: placementReader(() => placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  });

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(reclaim).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rejects a failed placement identity changed during the runtime drain", async ({
  signal,
}) => {
  const fixture = await preparePlacement("failed");
  const { storePath } = fixture;
  let { placement } = fixture;
  const drainGate = createDeferredCore();
  const drainEntered = createDeferredCore();
  const release = vi.fn();
  const reclaim = vi.fn();
  const drainStarted = vi.fn(() => {
    drainEntered.resolve();
    return { drained: drainGate.promise, hasWork: () => false, release };
  });

  const archive = patchPlacement({
    workerEnvironmentService: createWorkerInferenceDrainService(drainStarted),
    workerSessionPlacementService: placementReader(() => placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  });

  const settledArchive = Promise.allSettled([archive]);
  const cleanup = async () => {
    drainGate.resolve();
    await settledArchive;
  };
  pendingArchiveCleanups.add(cleanup);
  try {
    await Promise.race([
      drainEntered.promise,
      archive.then((result) => {
        throw new Error(
          `Archive settled before its runtime drain: ${result.error?.message ?? "no drain"}`,
        );
      }),
    ]);
    signal.throwIfAborted();
    expect(drainStarted).toHaveBeenCalledOnce();
    placement = workerPlacement({
      sessionId,
      sessionKey: "agent:main:replacement-placement",
      state: "active",
    });
    drainGate.resolve();

    await expect(archive).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
    expect(reclaim).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  } finally {
    await cleanup();
    pendingArchiveCleanups.delete(cleanup);
  }
});

test("sessions.patch keeps reconciliation pending before cancellation", async () => {
  const { storePath, placement } = await preparePlacement("reconciling");
  const reclaim = vi.fn();
  embeddedRunMock.activeIds.add(sessionId);
  const archived = await patchPlacement({
    workerSessionPlacementService: placementReader(() => placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  });
  expect(archived).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(reclaim).not.toHaveBeenCalled();
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch keeps restore blocked for an active cloud placement", async () => {
  const { storePath, placement } = await preparePlacement("active", true);

  const restored = await patchPlacement(
    { workerSessionPlacementService: placementReader(() => placement) },
    false,
  );

  expect(restored).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBe(1);
});
