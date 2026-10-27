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
import {
  ACTIVE_PLACEMENT,
  coordinate,
  LOCAL_PLACEMENT,
  preparedReclaim,
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
const archivedAt = (storePath: string, key = sessionKey) =>
  loadSessionEntry({ storePath, sessionKey: key })?.archivedAt;
function expectUnavailableArchive(
  result: Awaited<ReturnType<typeof directSessionReq>>,
  storePath: string,
) {
  expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(archivedAt(storePath)).toBeUndefined();
}

async function preparePlacement(
  state: Parameters<typeof workerPlacement>[0]["state"],
  initiallyArchived = false,
) {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, initiallyArchived ? { archivedAt: 1 } : {}),
    },
  });
  const context: Record<string, unknown> = {};
  const fixture = {
    dir,
    storePath,
    placement: workerPlacement({ sessionId, sessionKey, state }),
    reclaim: vi.fn<() => Promise<ReturnType<typeof workerPlacement>>>(),
    patch(
      overrides: Record<string, unknown> = {},
      archived = true,
    ): ReturnType<typeof directSessionReq> {
      Object.assign(context, overrides);
      return directSessionReq(
        "sessions.patch",
        { key: sessionKey, archived, expectedSessionId: sessionId },
        { context },
      );
    },
  };
  Object.assign(context, {
    workerSessionPlacementService: placementReader(() => fixture.placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim: fixture.reclaim },
  });
  return fixture;
}

const idleDrain = (release = vi.fn(), drained = Promise.resolve()) => ({
  drained,
  hasWork: () => false,
  release,
});
const waitForPhase = (phase: Promise<unknown>, archive: Promise<unknown>) =>
  Promise.race([
    phase,
    archive.then((result) => {
      throw new Error("Archive settled before its fixture phase", { cause: result });
    }),
  ]);

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
  const fixture = await preparePlacement("active");
  const { dir, storePath } = fixture;
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
    fixture.placement = local;
    return local;
  });
  const dispatchEntered = createDeferredCore();
  const releaseDispatch = createDeferredCore();
  const reconcile = vi.fn(async () => {});
  const coordinated = coordinate({
    dispatch: async (request) => {
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { ...ACTIVE_PLACEMENT, ...request };
    },
    reconcile,
    reclaim: preparedReclaim(reclaim),
  });
  const dispatch = coordinated.dispatch({
    ...REQUEST,
    sessionId: "unrelated-session",
    sessionKey: "agent:main:unrelated-session",
  });
  await dispatchEntered.promise;
  const sweep = coordinated.reconcile();
  const archive = () =>
    fixture.patch({
      workerEnvironmentService: environments,
      workerPlacementDispatchService: coordinated,
    });
  const first = archive();
  try {
    await waitForPhase(reclaimStarted.promise, first);
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
    expect(archivedAt(storePath)).toBeUndefined();
    releaseReclaim.resolve();
    expect(await first).toMatchObject({ ok: false });
    expect(await archive()).toMatchObject({ ok: true });
    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(archivedAt(storePath)).toEqual(expect.any(Number));
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
    const harness = await createHarness(database, placements, { workspacePath: dir, destroyFails });
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
    // Keep the runtime read in flight through our own cleanup publication.
    const reclaimed = createDeferredCore();
    const reclaim = harness.service.reclaim.bind(harness.service);
    vi.spyOn(harness.service, "reclaim").mockImplementation(async (...args) => {
      try {
        return await reclaim(...args);
      } finally {
        reclaimed.resolve();
      }
    });
    const readProjection = placements.readProjection.bind(placements);
    const prepareRuntimeRefresh = placements.prepareRuntimeRefresh.bind(placements);
    let refreshingRuntime = false;
    vi.spyOn(placements, "prepareRuntimeRefresh").mockImplementation(async (...args) => {
      refreshingRuntime = true;
      try {
        return await prepareRuntimeRefresh(...args);
      } finally {
        refreshingRuntime = false;
      }
    });
    vi.spyOn(placements, "readProjection").mockImplementation(async (...args) => {
      const projection = await readProjection(...args);
      if (refreshingRuntime) {
        await reclaimed.promise;
      }
      return projection;
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
            () => idleDrain(),
            harness.environments,
          ),
          workerSessionPlacementService: placements,
          workerPlacementDispatchService: harness.service,
        },
      },
    );
    try {
      await waitForPhase(destroying.promise, archive);
      expect(archivedAt(storePath, REQUEST.sessionKey)).toBeUndefined();
      release.resolve();
      if (destroyFails) {
        await expect(archive).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
        expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
        expect(harness.environments.get(harness.ready.environmentId)?.state).not.toBe("destroyed");
        expect(archivedAt(storePath, REQUEST.sessionKey)).toBeUndefined();
        return;
      }
      await expect(archive).resolves.toMatchObject({ ok: true });
      expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
      expect(harness.environments.get(harness.ready.environmentId)?.state).toBe("destroyed");
      expect(archivedAt(storePath, REQUEST.sessionKey)).toEqual(expect.any(Number));
    } finally {
      release.resolve();
      await archive;
    }
  },
);

test.each(["rejected", "unavailable"] as const)(
  "sessions.patch leaves active placement unarchived and releases its drain when reclaim is %s",
  async (failure) => {
    const fixture = await preparePlacement("active");
    const release = vi.fn();
    const reclaim = fixture.reclaim.mockRejectedValue(new Error("provider reclaim rejected"));
    const workerPlacementDispatchService =
      failure === "rejected" ? { dispatch: vi.fn(), reclaim } : { dispatch: vi.fn() };

    const archived = await fixture.patch({
      workerEnvironmentService: createWorkerInferenceDrainService(() => idleDrain(release)),
      workerPlacementDispatchService,
    });

    expectUnavailableArchive(archived, fixture.storePath);
    expect(release).toHaveBeenCalledOnce();
    expect(reclaim).toHaveBeenCalledTimes(failure === "rejected" ? 1 : 0);
  },
);

test.each(["agent:main:wrong-session", sessionKey])(
  "sessions.patch rejects reclaimed identity %s while authoritative placement remains active",
  async (returnedKey) => {
    const fixture = await preparePlacement("active");
    fixture.reclaim.mockResolvedValue(
      workerPlacement({ sessionId, sessionKey: returnedKey, state: "reclaimed" }),
    );
    expectUnavailableArchive(await fixture.patch(), fixture.storePath);
    expect(fixture.reclaim).toHaveBeenCalledOnce();
  },
);

test("sessions.patch rejects a failed placement identity changed during the runtime drain", async ({
  signal,
}) => {
  const fixture = await preparePlacement("failed");
  const { storePath } = fixture;
  const drainGate = createDeferredCore();
  const drainEntered = createDeferredCore();
  const release = vi.fn();
  const reclaim = vi.fn();
  const drainStarted = vi.fn(() => {
    drainEntered.resolve();
    return idleDrain(release, drainGate.promise);
  });

  const archive = fixture.patch({
    workerEnvironmentService: createWorkerInferenceDrainService(drainStarted),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  });

  const settledArchive = Promise.allSettled([archive]);
  const cleanup = async () => {
    drainGate.resolve();
    await settledArchive;
  };
  pendingArchiveCleanups.add(cleanup);
  try {
    await waitForPhase(drainEntered.promise, archive);
    signal.throwIfAborted();
    expect(drainStarted).toHaveBeenCalledOnce();
    fixture.placement = workerPlacement({
      sessionId,
      sessionKey: "agent:main:replacement-placement",
      state: "active",
    });
    drainGate.resolve();

    expectUnavailableArchive(await archive, storePath);
    expect(reclaim).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await cleanup();
    pendingArchiveCleanups.delete(cleanup);
  }
});

test("sessions.patch keeps reconciliation pending before cancellation", async () => {
  const fixture = await preparePlacement("reconciling");
  embeddedRunMock.activeIds.add(sessionId);
  expectUnavailableArchive(await fixture.patch(), fixture.storePath);
  expect(fixture.reclaim).not.toHaveBeenCalled();
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
});

test("sessions.patch keeps restore blocked for an active cloud placement", async () => {
  const fixture = await preparePlacement("active", true);
  const restored = await fixture.patch({ workerPlacementDispatchService: undefined }, false);

  expect(restored).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(archivedAt(fixture.storePath)).toBe(1);
});
