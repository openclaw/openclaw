import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function workerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  agentId?: string;
  environmentId?: string | null;
}): WorkerSessionPlacementRecord {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    executionMode: "worker-turn",
    state: params.state,
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId:
      params.environmentId !== undefined
        ? params.environmentId
        : params.state === "local" || params.state === "requested"
          ? null
          : "worker-environment",
    activeOwnerEpoch: ["active", "draining", "reconciling", "reclaimed", "failed"].includes(
      params.state,
    )
      ? 1
      : null,
    workspaceBaseManifestRef:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "manifest-ref",
    remoteWorkspaceDir:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "/workspace",
    workerBundleHash:
      params.state === "local" || params.state === "requested" || params.state === "provisioning"
        ? null
        : "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: params.state === "failed" ? "worker recovery stopped" : null,
  } as WorkerSessionPlacementRecord;
}

function placementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
    getMany(sessionIds: readonly string[]) {
      const placement = current();
      return new Map(
        placement && sessionIds.includes(placement.sessionId)
          ? [[placement.sessionId, placement]]
          : [],
      );
    },
  };
}

test.each([false, true])(
  "sessions.patch archives past queued maintenance and explains concurrent requests (cleanup fails=%s)",
  async (cleanupFails) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-already-stopping";
    const sessionId = "session-archive-already-stopping";
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
      store: environmentStore,
      getConfig: () => ({}),
      resolveProvider: () => undefined,
      prepareInstallation: unexpectedWorkerWork,
      bootstrapWorker: unexpectedWorkerWork,
      executeInference: unexpectedWorkerWork,
    });
    const reclaimStarted = createDeferredCore();
    const releaseReclaim = createDeferredCore();
    const reclaim = vi.fn(async () => {
      reclaimStarted.resolve();
      await releaseReclaim.promise;
      if (cleanupFails && reclaim.mock.calls.length === 1) {
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
      for (let attempt = 0; attempt < 2; attempt++) {
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
      }
      releaseReclaim.resolve();
      expect(await first).toMatchObject({ ok: !cleanupFails });
      if (cleanupFails) {
        expect(await archive()).toMatchObject({ ok: true });
        expect(reclaim).toHaveBeenCalledTimes(2);
      }
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      releaseReclaim.resolve();
      releaseDispatch.resolve();
      await Promise.all([first, dispatch, sweep]);
      await environments.stop();
    }
  },
);

test.each([false, true])(
  "sessions.patch waits for orphaned provisioning cleanup (failure=%s)",
  async (destroyFails) => {
    const { dir, storePath } = await createSessionStoreDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } });
    const placements = createWorkerSessionPlacementStore({ database });
    const harness = createHarness(database, placements, { workspacePath: dir, destroyFails });
    seedProvisioningPlacement(placements, harness.ready.environmentId);
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

test("sessions.patch reclaims the exact active cloud placement before archive metadata commits", async () => {
  const { storePath } = await createSessionStoreDir();
  const requestedKey = "archive-cloud-active";
  const sessionKey = `agent:main:${requestedKey}`;
  const sessionId = "session-archive-cloud-active";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaimStarted = createDeferredCore();
  const reclaimGate = createDeferredCore();
  const reclaim = vi.fn(async () => {
    reclaimStarted.resolve();
    await reclaimGate.promise;
    placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });

  const archive = directSessionReq(
    "sessions.patch",
    { key: requestedKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  try {
    await Promise.race([
      reclaimStarted.promise,
      archive.then((result) => {
        expect(result).toMatchObject({ ok: true });
        throw new Error("archive completed before worker reclaim");
      }),
    ]);
    expect(reclaim).toHaveBeenCalledOnce();
    expect(reclaim).toHaveBeenCalledWith(
      { sessionId, sessionKey, agentId: "main" },
      expect.any(Function),
      expect.any(Function),
    );
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    reclaimGate.resolve();

    await expect(archive).resolves.toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  } finally {
    // Join the held request before fixture teardown closes its databases.
    reclaimGate.resolve();
    await archive;
  }
});

test.each(["rejected", "unavailable"] as const)(
  "sessions.patch leaves active placement unarchived and releases its drain when reclaim is %s",
  async (failure) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:archive-cloud-${failure}`;
    const sessionId = `session-archive-cloud-${failure}`;
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const release = vi.fn();
    const reclaim = vi.fn(async () => {
      throw new Error("provider reclaim rejected");
    });
    const workerPlacementDispatchService =
      failure === "rejected" ? { dispatch: vi.fn(), reclaim } : { dispatch: vi.fn() };

    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: {
          workerEnvironmentService: createWorkerInferenceDrainService(() => ({
            drained: Promise.resolve(),
            hasWork: () => false,
            release,
          })),
          workerSessionPlacementService: placementReader(() => placement),
          workerPlacementDispatchService,
        },
      },
    );

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
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-identity";
  const sessionId = "session-archive-cloud-identity";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaim = vi.fn(async () =>
    workerPlacement({
      sessionId,
      sessionKey: "agent:main:wrong-session",
      state: "reclaimed",
    }),
  );

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rejects a reclaimed return when its authoritative placement stayed active", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-stale-reclaim";
  const sessionId = "session-archive-cloud-stale-reclaim";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaim = vi.fn(async () => workerPlacement({ sessionId, sessionKey, state: "reclaimed" }));

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(reclaim).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test.each(["active", "failed"] as const)(
  "sessions.patch rejects a %s placement identity changed during the runtime drain",
  async (state) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-cloud-fresh-placement";
    const sessionId = "session-archive-cloud-fresh-placement";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    let placement = workerPlacement({ sessionId, sessionKey, state });
    const drainGate = createDeferredCore();
    const drainEntered = createDeferredCore();
    const drainStarted = vi.fn(() => drainEntered.resolve());
    const release = vi.fn();
    const reclaim = vi.fn();

    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: {
          workerEnvironmentService: createWorkerInferenceDrainService(() => {
            drainStarted();
            return { drained: drainGate.promise, hasWork: () => false, release };
          }),
          workerSessionPlacementService: placementReader(() => placement),
          workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        },
      },
    );

    try {
      await Promise.race([
        drainEntered.promise,
        archive.then((result) => {
          expect(result).toMatchObject({ ok: true });
          throw new Error("archive completed before runtime drain");
        }),
      ]);
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
      // Release and join even when a phase assertion fails, before fixture reset.
      drainGate.resolve();
      await archive;
    }
  },
);

test.each(["requested", "provisioning", "syncing", "starting", "draining"] as const)(
  "sessions.patch stops %s placement before archiving",
  async (state) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:archive-cloud-${state}`;
    const sessionId = `session-archive-cloud-${state}`;
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    let placement = workerPlacement({ sessionId, sessionKey, state });
    const reclaim = vi.fn(async () => {
      placement = workerPlacement({ sessionId, sessionKey, state: "local" });
      return placement;
    });
    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: {
          workerSessionPlacementService: placementReader(() => placement),
          workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        },
      },
    );
    expect(archived).toMatchObject({ ok: true });
    expect(reclaim).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  },
);

test("sessions.patch keeps reconciliation pending before cancellation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-reconciling";
  const sessionId = "session-archive-cloud-reconciling";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: "reconciling" });
  const reclaim = vi.fn();
  embeddedRunMock.activeIds.add(sessionId);
  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );
  expect(archived).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(reclaim).not.toHaveBeenCalled();
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test.each([
  { name: "local", state: "local" as const },
  { name: "reclaimed", state: "reclaimed" as const },
  { name: "failed after its environment is gone", state: "failed" as const, gone: true },
])("sessions.patch archives $name placement without reclaim", async (testCase) => {
  const { storePath } = await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `agent:main:archive-cloud-${caseId}`;
  const sessionId = `session-archive-cloud-${caseId}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: testCase.state });
  const reclaim = vi.fn();

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        ...(testCase.gone
          ? {
              workerEnvironmentService: {
                get: () => ({ state: "destroyed" }),
                cancelInferenceForSession: vi.fn(() => []),
                hasInferenceForSession: vi.fn(() => false),
                resolveInferenceSessionForRunId: vi.fn(),
              },
            }
          : {}),
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({ ok: true });
  expect(reclaim).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
});

test.each([
  { name: "reclaimed", state: "reclaimed" as const },
  { name: "failed after its environment is gone", state: "failed" as const, gone: true },
])("sessions.patch restores $name placement", async (testCase) => {
  const { storePath } = await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `agent:main:restore-cloud-${caseId}`;
  const sessionId = `session-restore-cloud-${caseId}`;
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { archivedAt: 1 }) },
  });
  const placement = workerPlacement({ sessionId, sessionKey, state: testCase.state });

  const restored = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: false, expectedSessionId: sessionId },
    {
      context: {
        ...(testCase.gone
          ? {
              workerEnvironmentService: {
                get: () => ({ state: "destroyed" }),
                cancelInferenceForSession: vi.fn(() => []),
                hasInferenceForSession: vi.fn(() => false),
                resolveInferenceSessionForRunId: vi.fn(),
              },
            }
          : {}),
        workerSessionPlacementService: placementReader(() => placement),
      },
    },
  );

  expect(restored).toMatchObject({ ok: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch keeps restore blocked for an active cloud placement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:restore-cloud-active";
  const sessionId = "session-restore-cloud-active";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { archivedAt: 1 }) },
  });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });

  const restored = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: false, expectedSessionId: sessionId },
    { context: { workerSessionPlacementService: placementReader(() => placement) } },
  );

  expect(restored).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBe(1);
});

test("sessions.patchMany isolates a reclaim failure and archives a later target in input order", async () => {
  const { storePath } = await createSessionStoreDir();
  const failedKey = "agent:main:archive-batch-reclaim-failed";
  const laterKey = "agent:main:archive-batch-reclaim-later";
  const failedSessionId = "session-batch-reclaim-failed";
  const laterSessionId = "session-batch-reclaim-later";
  await writeSessionStore({
    entries: {
      [failedKey]: sessionStoreEntry(failedSessionId),
      [laterKey]: sessionStoreEntry(laterSessionId),
    },
  });
  const placements = new Map([
    [
      failedSessionId,
      workerPlacement({ sessionId: failedSessionId, sessionKey: failedKey, state: "active" }),
    ],
    [
      laterSessionId,
      workerPlacement({ sessionId: laterSessionId, sessionKey: laterKey, state: "local" }),
    ],
  ]);
  const reclaim = vi.fn(async () => {
    throw new Error("reclaim failed");
  });

  const result = await directSessionReq<{
    outcomes: Array<{ error?: { code: string; retryable?: boolean }; key: string; ok: boolean }>;
  }>(
    "sessions.patchMany",
    {
      targets: [
        { key: failedKey, expectedSessionId: failedSessionId },
        { key: laterKey, expectedSessionId: laterSessionId },
      ],
      patch: { archived: true },
    },
    {
      context: {
        workerSessionPlacementService: {
          getMany: (sessionIds: readonly string[]) =>
            new Map(
              sessionIds.flatMap((sessionId) => {
                const placement = placements.get(sessionId);
                return placement ? [[sessionId, placement] as const] : [];
              }),
            ),
        },
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(result.payload?.outcomes).toEqual([
    {
      key: failedKey,
      ok: false,
      error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    },
    { key: laterKey, ok: true },
  ]);
  expect(reclaim).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey: failedKey })?.archivedAt).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: laterKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
});
