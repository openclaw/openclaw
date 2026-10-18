import { afterEach, expect, test, vi } from "vitest";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  beforeResetHookMocks,
  beforeResetHookState,
  bundleMcpRuntimeMocks,
  directSessionReq,
  loadSeededTranscriptEvents,
  seedSessionTranscript,
  sessionStoreEntry,
  sessionHookMocks,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { LOCAL_PLACEMENT } from "./worker-environments/placement-dispatch-coordinator.test-support.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementRetirementService,
  WorkerSessionPlacementStore,
} from "./worker-environments/placement-store.js";
import { resolveSessionWorkerPlacementMutationError } from "./worker-environments/session-placement-lifecycle.js";
import { executeLocalTurn } from "./worker-environments/worker-turn-admission.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(closeStateDatabaseForTest);

function placementRecord(
  sessionId: string,
  state: "active" | "local" | "failed" | "reclaimed",
  sessionKey = "agent:main:worker-session",
): WorkerSessionPlacementRecord {
  const { profileId: _dispatchProfileId, ...local } = LOCAL_PLACEMENT;
  const identity = {
    ...local,
    sessionId,
    sessionKey,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    generation: 0,
  };
  if (state === "local") {
    return { ...identity, state };
  }
  const owned = {
    ...identity,
    generation: 2,
    environmentId: "worker-environment",
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: "manifest-ref",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "bundle-hash",
  };
  return state === "failed"
    ? {
        ...owned,
        state,
        recoveryError: "worker recovery stopped",
        terminalReason: "worker recovery stopped",
        terminalAtMs: 2,
      }
    : { ...owned, state };
}

const sessionEntry = async (key: string) => (await loadSessionEntryAsync(key)).entry;
const canonicalKey = async (key: string) => (await loadSessionEntryAsync(key)).canonicalKey ?? key;

async function seedTranscriptSnapshot(
  identity: Parameters<typeof loadSeededTranscriptEvents>[0],
  content: string,
) {
  await seedSessionTranscript({ ...identity, messages: [{ role: "user", content }] });
  const before = await loadSeededTranscriptEvents(identity);
  return async () => expect(await loadSeededTranscriptEvents(identity)).toEqual(before);
}

const unchangedWorkspace = { reconcileChanged: false, reconcileCommitsManifest: false };
async function seededWorkerHarness(
  options: Parameters<typeof createHarness>[2] = unchangedWorkspace,
  overrides?: Parameters<typeof sessionStoreEntry>[1],
) {
  const session = await seedSession(REQUEST.sessionKey, REQUEST.sessionId, false, overrides);
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const harness = await createHarness(openOpenClawStateDatabase(), placementStore, options);
  return { ...session, placementStore, harness };
}

function observingRetirement(
  store: WorkerSessionPlacementStore,
  events: string[],
  beforeRetire?: () => Promise<void>,
) {
  return {
    getMany: (ids: readonly string[]) => store.getMany(ids),
    getManyAsync: (ids: readonly string[]) => store.getManyAsync(ids),
    async retireSessionPlacementAsync(retirement: WorkerSessionPlacementRetirement) {
      if (beforeRetire) {
        await beforeRetire();
      }
      expect(store.get(retirement.sessionId)?.turnClaim).toBeNull();
      events.push("placement:retire");
      await store.retireSessionPlacementAsync(retirement);
    },
  };
}

async function seedSession(
  sessionKey: string,
  sessionId: string,
  incognito = false,
  overrides?: Parameters<typeof sessionStoreEntry>[1],
) {
  const { storePath } = await createSessionStoreDir();
  if (!incognito) {
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId, overrides) } });
    return { sessionId, storePath };
  }
  const created = await directSessionReq<{ sessionId?: string }>("sessions.create", {
    agentId: "main",
    key: sessionKey,
    incognito: true,
  });
  if (!created.ok || !created.payload?.sessionId) {
    throw new Error(`incognito setup failed: ${JSON.stringify(created.error)}`);
  }
  return { sessionId: created.payload.sessionId, storePath };
}

function placementReq(
  method: Parameters<typeof directSessionReq>[0],
  key: string,
  context: Record<string, unknown>,
  params: Record<string, unknown> = {},
) {
  return directSessionReq(method, { key, ...params }, { context });
}

function sequencedPlacementReader(
  records: readonly WorkerSessionPlacementRecord[],
): WorkerSessionPlacementReader {
  let readIndex = 0;
  return {
    getMany(sessionIds) {
      const record = records[Math.min(readIndex, records.length - 1)];
      readIndex += 1;
      return new Map(
        record && sessionIds.includes(record.sessionId) ? [[record.sessionId, record]] : [],
      );
    },
  };
}

function sequencedPlacementService(
  records: readonly WorkerSessionPlacementRecord[],
  retire: WorkerSessionPlacementRetirementService["retireSessionPlacement"] = () => {},
) {
  return { ...sequencedPlacementReader(records), retireSessionPlacement: vi.fn(retire) };
}

test.each([
  { action: "fork" as const, allowed: true },
  { action: "restore" as const, allowed: false },
])("stopped cloud placement only permits identity-preserving $action", ({ action, allowed }) => {
  for (const state of ["reclaimed", "failed"] as const) {
    const sessionId = `stopped-${state}-${action}`;
    const placement = placementRecord(sessionId, state);
    const placementService = sequencedPlacementService([placement]);
    const error = resolveSessionWorkerPlacementMutationError({
      action,
      context: {
        workerEnvironmentService: { get: () => ({ state: "destroyed" }) } as never,
        workerSessionPlacementService: placementService,
      },
      key: placement.sessionKey,
      sessionId,
    });

    if (allowed) {
      expect(error).toBeUndefined();
    } else {
      expect(error?.message).toContain(`cannot ${action} while cloud worker placement is ${state}`);
    }
    expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
  }
});

async function beginClaimedTurn(params: {
  events: string[];
  onInterrupt?: () => void;
  owner?: Parameters<WorkerSessionPlacementStore["claimTurn"]>[0]["owner"];
  placementStore: WorkerSessionPlacementStore;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<() => Promise<void>> {
  const claim = await params.placementStore.claimTurn({
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: await canonicalKey(params.sessionKey),
    owner: params.owner ?? { kind: "local" },
    claimId: `${params.sessionId}-claim`,
    runId: `${params.sessionId}-run`,
  });
  let releasing: Promise<void> | undefined;
  let releaseAdmission = () => {};
  const releaseClaim = () => {
    releasing ??= params.placementStore
      .releaseTurn(claim)
      .then(() => {
        params.events.push("claim:released");
      })
      .finally(() => releaseAdmission());
    return releasing;
  };
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      params.events.push("admission:interrupt");
      params.onInterrupt?.();
      void releaseClaim().catch(() => {});
    },
  });
  releaseAdmission = admission.release;
  return () => releaseClaim().finally(admission.release);
}

async function seedClaimedSession(sessionKey: string, incognito = false, onInterrupt?: () => void) {
  const { sessionId } = await seedSession(sessionKey, "sess-active-local-reset", incognito);
  const { storePath } = await loadSessionEntryAsync(sessionKey);
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  const cleanupAdmission = await beginClaimedTurn({
    events,
    onInterrupt,
    placementStore,
    sessionId,
    sessionKey,
    storePath,
  });
  return { sessionId, placementStore, events, cleanupAdmission };
}

test("sessions.reset rechecks worker placement inside the lifecycle fence", async () => {
  await seedActiveMainSession();
  const placementService = sequencedPlacementService([
    placementRecord("sess-main", "local"),
    placementRecord("sess-main", "active"),
  ]);
  const getWorkerEnvironment = vi.fn();

  const reset = await placementReq("sessions.reset", "main", {
    workerEnvironmentService: { get: getWorkerEnvironment } as never,
    workerSessionPlacementService: placementService,
  });

  expect(reset.ok).toBe(false);
  expect(reset.error?.message).toContain("cloud worker placement is active");
  expect(await sessionEntry("main")).toMatchObject({ sessionId: "sess-main" });
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(getWorkerEnvironment).not.toHaveBeenCalled();
  expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
});

test("sessions.reset preserves device-folder affinity after reclaim and refuses a Gateway turn", async () => {
  const deviceFolder = { deviceId: "paired-folder-device", path: "/existing/non-git" };
  const { placementStore, harness } = await seededWorkerHarness(undefined, { deviceFolder });
  await harness.service.dispatch(REQUEST);
  expect(await harness.service.reclaim(REQUEST)).toMatchObject({ state: "reclaimed" });

  const reset = await directSessionReq<{ entry: { deviceFolder?: typeof deviceFolder } }>(
    "sessions.reset",
    { key: REQUEST.sessionKey },
    { context: { workerSessionPlacementService: placementStore } },
  );
  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();
  expect(reset.payload?.entry.deviceFolder).toEqual(deviceFolder);
  expect((await sessionEntry(REQUEST.sessionKey))?.deviceFolder).toEqual(deviceFolder);

  const runLocal = vi.fn(async () => "must not execute");
  await expect(
    executeLocalTurn({
      claim: { ...REQUEST, runId: "post-reset-gateway-turn" },
      placements: placementStore,
      runLocal,
    }),
  ).rejects.toThrow("Dispatch it to that device before sending a turn");
  expect(runLocal).not.toHaveBeenCalled();
  expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();

  const dispatch = vi.fn();
  const wrongDevice = await placementReq(
    "sessions.dispatch",
    REQUEST.sessionKey,
    {
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: placementStore,
    },
    { deviceId: "another-device" },
  );
  expect(wrongDevice).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("dispatch explicitly to that device") },
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(["generation", "environment", "session key"] as const)(
  "sessions.delete rejects placement %s replacement across the runtime drain",
  async (change) => {
    const sessionKey = "agent:main:worker-drain-race";
    const sessionId = "worker-drain-race";
    await seedSession(sessionKey, sessionId);
    let placement = placementRecord(sessionId, "active", sessionKey);
    const started = createDeferredCore<boolean>();
    const gate = createDeferredCore();
    const release = vi.fn();
    const reclaim = vi.fn();
    const deletion = placementReq("sessions.delete", sessionKey, {
      workerSessionPlacementService: { getMany: () => new Map([[sessionId, placement]]) },
      workerPlacementDispatchService: { reclaim },
      workerEnvironmentService: createWorkerInferenceDrainService(() => {
        started.resolve(true);
        return { drained: gate.promise, hasWork: () => false, release };
      }),
    });
    try {
      expect(await Promise.race([started.promise, deletion.then(() => false)])).toBe(true);
      placement = {
        ...placement,
        ...(change === "generation"
          ? { generation: placement.generation + 1 }
          : change === "environment"
            ? { environmentId: "replacement-environment" }
            : { sessionKey: "agent:main:replacement" }),
      } as WorkerSessionPlacementRecord;
    } finally {
      gate.resolve();
    }
    expect(await deletion).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(reclaim).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(await sessionEntry(sessionKey)).toMatchObject({ sessionId });
  },
);

test.each([
  ["discord:group:active-local-delete", "discord:group:active-local-delete"],
  ["agent:main:cron:adopted-job", "agent:main:cron:adopted-job:run:original-session-id"],
])("sessions.delete drains %s before placement retirement", async (sessionKey, placementKey) => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-active-local-delete";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
      [placementKey]: sessionStoreEntry(sessionId),
    },
  });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  const cleanupAdmission = await beginClaimedTurn({
    events,
    placementStore,
    sessionId,
    sessionKey: placementKey,
    storePath,
  });

  try {
    const deleted = await placementReq("sessions.delete", sessionKey, {
      workerSessionPlacementService: {
        ...observingRetirement(placementStore, events),
        waitForTurnClaimRelease: (
          ...args: Parameters<WorkerSessionPlacementStore["waitForTurnClaimRelease"]>
        ) => placementStore.waitForTurnClaimRelease(...args),
      },
    });

    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(events).toEqual(["admission:interrupt", "claim:released", "placement:retire"]);
    expect(placementStore.get(sessionId)).toBeUndefined();
    expect(await sessionEntry(sessionKey)).toBeUndefined();
    if (placementKey !== sessionKey) {
      expect(await sessionEntry(placementKey)).toMatchObject({ sessionId });
    }
  } finally {
    await cleanupAdmission();
  }
});

test("sessions.delete retains failed placement when worker cleanup is unavailable", async () => {
  const sessionKey = "discord:group:failed-worker-session";
  const sessionId = "sess-failed-worker-delete";
  await seedSession(sessionKey, sessionId);
  const placementService = sequencedPlacementService([
    placementRecord(sessionId, "failed", await canonicalKey(sessionKey)),
  ]);

  const deleted = await placementReq("sessions.delete", sessionKey, {
    workerEnvironmentService: { get: () => ({ state: "failed", leaseId: "lease-1" }) } as never,
    workerSessionPlacementService: placementService,
  });

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toContain("cloud worker reclaim is unavailable");
  expect(await sessionEntry(sessionKey)).toMatchObject({ sessionId });
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
});

test.each([false, true])(
  "sessions.reset drains an active local claim before placement retirement (incognito=%s)",
  async (incognito) => {
    const sessionKey = incognito
      ? "agent:main:dashboard:incognito-active-local-reset"
      : "discord:group:active-local-reset";
    const { sessionId, placementStore, events, cleanupAdmission } = await seedClaimedSession(
      sessionKey,
      incognito,
    );

    try {
      const reset = await placementReq("sessions.reset", sessionKey, {
        workerSessionPlacementService: observingRetirement(placementStore, events, async () => {
          expect(await sessionEntry(sessionKey)).toMatchObject({ sessionId });
        }),
      });

      expect(reset.ok).toBe(true);
      expect(events).toEqual(["admission:interrupt", "claim:released", "placement:retire"]);
      expect(placementStore.get(sessionId)).toBeUndefined();
      expect((await sessionEntry(sessionKey)) === undefined).toBe(incognito);
    } finally {
      await cleanupAdmission();
    }
  },
);

test("sessions.reset rechecks lifecycle ownership after draining before placement retirement", async () => {
  const sessionKey = "discord:group:revoked-during-reset-drain";
  let lifecycleCurrent = true;
  const { sessionId, placementStore, events, cleanupAdmission } = await seedClaimedSession(
    sessionKey,
    false,
    () => {
      lifecycleCurrent = false;
    },
  );
  const retireSessionPlacementAsync = vi.fn((retirement: WorkerSessionPlacementRetirement) =>
    placementStore.retireSessionPlacementAsync(retirement),
  );
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  try {
    await expect(
      performGatewaySessionReset({
        key: sessionKey,
        reason: "reset",
        commandSource: "gateway:agent",
        workerPlacementContext: {
          workerSessionPlacementService: {
            getMany: (sessionIds: readonly string[]) => placementStore.getMany(sessionIds),
            retireSessionPlacementAsync,
          },
        },
        assertCurrent: () => {
          if (!lifecycleCurrent) {
            throw new Error("stale lifecycle after drain");
          }
        },
      }),
    ).rejects.toThrow("stale lifecycle after drain");
    expect(events).toEqual(["admission:interrupt", "claim:released"]);
    expect(retireSessionPlacementAsync).not.toHaveBeenCalled();
    expect(placementStore.get(sessionId)).toMatchObject({ state: "local", turnClaim: null });
    expect(await sessionEntry(sessionKey)).toMatchObject({ sessionId });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  } finally {
    await cleanupAdmission();
  }
});

test.each(["released synchronous", "async"] as const)(
  "sessions.reset preserves custom %s placement retirement after bootstrap teardown",
  async (retirementMode) => {
    const sessionKey = "discord:group:failed-worker-reset";
    const sessionId = "sess-failed-worker-reset";
    await seedSession(sessionKey, sessionId);
    const placement = placementRecord(sessionId, "failed");
    const retired: WorkerSessionPlacementRetirement[] = [];
    const placementService = {
      ...sequencedPlacementReader([placement]),
      retired,
      retireSessionPlacement(input: WorkerSessionPlacementRetirement) {
        this.retired.push(input);
      },
      ...(retirementMode === "async"
        ? {
            async retireSessionPlacementAsync(
              this: WorkerSessionPlacementRetirementService,
              input: WorkerSessionPlacementRetirement,
            ) {
              this.retireSessionPlacement(input);
            },
          }
        : {}),
    };

    const reset = await placementReq("sessions.reset", sessionKey, {
      workerEnvironmentService: { get: () => ({ state: "failed", leaseId: null }) } as never,
      workerSessionPlacementService: placementService,
    });

    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    expect(retired).toEqual([
      {
        status: "retirement-required",
        sessionId,
        expectedState: "failed",
        expectedGeneration: placement.generation,
      },
    ]);
    expect(await sessionEntry(sessionKey)).toBeDefined();
  },
);

test.each([false, true])(
  "sessions.reset leaves ownership untouched on retirement generation races (incognito=%s)",
  async (incognito) => {
    const sessionKey = incognito
      ? "agent:main:dashboard:incognito-retirement-failure-reset"
      : "discord:group:retirement-failure-reset";
    const { sessionId, storePath } = await seedSession(
      sessionKey,
      "sess-retirement-failure-reset",
      incognito,
    );
    const expectTranscriptUnchanged = await seedTranscriptSnapshot(
      { sessionId, sessionKey, storePath },
      "keep this reset transcript",
    );
    const entryBefore = structuredClone(await sessionEntry(sessionKey));
    const placement = placementRecord(sessionId, "local");
    const placementService = sequencedPlacementService([placement], () => {
      throw new Error("placement generation changed before retirement");
    });
    beforeResetHookState.hasBeforeResetHook = true;
    sessionHookMocks.triggerInternalHook.mockClear();
    beforeResetHookMocks.runBeforeReset.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockClear();
    embeddedRunMock.activeIds.add(sessionId);

    await expect(
      placementReq("sessions.reset", sessionKey, {
        workerSessionPlacementService: placementService,
      }),
    ).rejects.toThrow("placement generation changed before retirement");

    expect(await sessionEntry(sessionKey)).toEqual(entryBefore);
    await expectTranscriptUnchanged();
    expect(placementService.getMany([sessionId]).get(sessionId)).toEqual(placement);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  },
);

test.each(["generation", "claim"] as const)(
  "sessions.delete fences a placement %s change before deleting the session",
  async (change) => {
    const sessionKey = `discord:group:retirement-${change}-race`;
    const sessionId = `sess-retirement-${change}-race`;
    const { storePath } = await seedSession(sessionKey, sessionId);
    const expectTranscriptUnchanged = await seedTranscriptSnapshot(
      { sessionId, sessionKey, storePath },
      `keep the ${change} race transcript`,
    );
    embeddedRunMock.activeIds.add(sessionId);
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const initialClaim = await placementStore.claimTurn({
      sessionId,
      agentId: "main",
      sessionKey: await canonicalKey(sessionKey),
      owner: { kind: "local" },
      claimId: `initial-${change}-claim`,
      runId: `initial-${change}-run`,
    });
    await placementStore.releaseTurn(initialClaim);
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
      const identity = { sessionId, agentId: "main", sessionKey: await canonicalKey(sessionKey) };
      if (change === "generation") {
        await placementStore.startDispatch(identity);
      } else {
        await placementStore.claimTurn({
          ...identity,
          owner: { kind: "local" },
          claimId: "racing-local-claim",
          runId: "racing-local-run",
        });
      }
    });
    const deletion = placementReq("sessions.delete", sessionKey, {
      workerSessionPlacementService: placementStore,
    });
    await expect(deletion).rejects.toThrow("changed before retirement");
    expect(await sessionEntry(sessionKey)).toMatchObject({ sessionId });
    await expectTranscriptUnchanged();
    expect(placementStore.get(sessionId)).toBeDefined();
  },
);

test.each(["worker-turn", "remote-exec"] as const)(
  "sessions.delete safely reclaims an active %s placement before committing deletion",
  async (executionMode) => {
    const release = vi.fn();
    const { storePath, placementStore, harness } = await seededWorkerHarness({
      ...unchangedWorkspace,
      afterReconcile: async () => {
        expect(await sessionEntry(REQUEST.sessionKey)).toMatchObject({
          sessionId: REQUEST.sessionId,
        });
        expect(release).not.toHaveBeenCalled();
      },
    });
    const active = await harness.service.dispatch({ ...REQUEST, executionMode });
    const events: string[] = [];
    const releaseTurn = await beginClaimedTurn({
      ...REQUEST,
      storePath,
      placementStore,
      events,
      owner: {
        kind: executionMode === "worker-turn" ? "worker" : "local",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const retireSessionPlacementAsync = vi.fn(
      async (retirement: WorkerSessionPlacementRetirement) => {
        expect(await sessionEntry(REQUEST.sessionKey)).toBeUndefined();
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
        await placementStore.retireSessionPlacementAsync(retirement);
      },
    );
    const deleted = await placementReq("sessions.delete", REQUEST.sessionKey, {
      workerEnvironmentService: createWorkerInferenceDrainService(
        () => ({ drained: Promise.resolve(), hasWork: () => false, release }),
        harness.environments,
      ),
      workerPlacementDispatchService: harness.service,
      workerSessionPlacementService: { ...placementStore, retireSessionPlacementAsync },
    });
    await releaseTurn();
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(events).toEqual(["admission:interrupt", "claim:released"]);
    expect(harness.log.indexOf("workspace:reconcile")).toBeLessThan(
      harness.log.indexOf("teardown:destroy"),
    );
    expect(retireSessionPlacementAsync).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(await sessionEntry(REQUEST.sessionKey)).toBeUndefined();
  },
);

test.each(["worker-turn", "remote-exec"] as const)(
  "sessions.delete preserves %s recovery when the post-apply fence fails",
  async (executionMode) => {
    const { placementStore, harness } = await seededWorkerHarness({
      reconcileCommitsManifest: false,
      reconcileCommitsManifestOnApply: true,
      verifyFailurePhase: "after-apply",
    });
    await harness.service.dispatch({ ...REQUEST, executionMode });
    const forceDestroyEnvironment = vi.spyOn(harness.service, "forceDestroyEnvironment");
    const deleted = await placementReq("sessions.delete", REQUEST.sessionKey, {
      workerEnvironmentService: { ...harness.environments },
      workerPlacementDispatchService: harness.service,
      workerSessionPlacementService: placementStore,
    });
    expect(deleted).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(harness.log).toContain("workspace:apply-prepared");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();
    expect(await sessionEntry(REQUEST.sessionKey)).toMatchObject({ sessionId: REQUEST.sessionId });
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "draining",
      executionMode,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: { owner: executionMode === "remote-exec" ? "local" : "worker" },
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { workspaceAcceptedAtMs: null },
    ]);
  },
);

test("sessions.delete retains reclaimed placement when runtime cleanup fails before commit", async () => {
  const { placementStore, harness } = await seededWorkerHarness();
  await harness.service.dispatch(REQUEST);
  const reclaimed = await harness.service.reclaim(REQUEST);
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockRejectedValueOnce(
    new Error("runtime cleanup failed"),
  );
  await expect(
    placementReq("sessions.delete", REQUEST.sessionKey, {
      workerSessionPlacementService: placementStore,
    }),
  ).rejects.toThrow("runtime cleanup failed");
  expect(await sessionEntry(REQUEST.sessionKey)).toMatchObject({ sessionId: REQUEST.sessionId });
  expect(placementStore.get(REQUEST.sessionId)).toEqual(reclaimed);
});
