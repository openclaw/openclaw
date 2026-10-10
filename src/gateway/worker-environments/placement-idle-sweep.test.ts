import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createGatewayWorkerPlacementChangePublisher } from "../server-worker-placement-change-events.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useStateDatabaseTempDirs();

describe("worker placement idle suspension", () => {
  let nowMs: number;
  let database: OpenClawStateDatabase;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;

  beforeEach(() => {
    nowMs = 1_000;
    const root = tempDirs.make("openclaw-worker-idle-sweep-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });
  afterEach(() => vi.restoreAllMocks());

  function createIdleFixture(
    options: {
      suspendAfter?: string | null;
      destroyFails?: boolean;
      reclaim?: Parameters<typeof createWorkerPlacementIdleSweep>[0]["dispatch"]["reclaim"];
      reportChanges?: Parameters<typeof createWorkerPlacementIdleSweep>[0]["reportChanges"];
      isPlacementOperationInFlight?: (sessionId: string) => boolean;
      getSessionWorkAdmissionCheck?: (identity: {
        sessionId: string;
        sessionKey: string;
        agentId: string;
      }) => Promise<() => boolean>;
    } = {},
  ) {
    const harness = createHarness(database, placements, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      destroyFails: options.destroyFails,
    });
    const suspendAfter = options.suspendAfter === undefined ? "1m" : options.suspendAfter;
    const profile: CloudWorkerProfileConfig = {
      provider: "fake",
      ...(suspendAfter === null ? {} : { suspendAfter }),
    };
    const info = vi.fn();
    const warn = vi.fn();
    const isPlacementOperationInFlight = vi.fn(
      (sessionId: string) => options.isPlacementOperationInFlight?.(sessionId) ?? false,
    );
    const idleSweep = createWorkerPlacementIdleSweep({
      placements,
      environments: harness.environments,
      dispatch: { reclaim: options.reclaim ?? harness.service.reclaim },
      reportChanges: options.reportChanges ?? ((operation) => operation()),
      getConfig: () => ({
        cloudWorkers: {
          profiles: {
            [REQUEST.profileId]: profile,
          },
        },
      }),
      isPlacementOperationInFlight,
      ...(options.getSessionWorkAdmissionCheck
        ? { getSessionWorkAdmissionCheck: options.getSessionWorkAdmissionCheck }
        : {}),
      info,
      warn,
      now: () => nowMs,
    });
    return { harness, idleSweep, profile, info, warn, isPlacementOperationInFlight };
  }

  function claimWorkerTurn(claimId = "busy-worker-claim") {
    const active = placements.get(REQUEST.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected an active worker placement");
    }
    return placements.claimTurn({
      ...REQUEST,
      claimId,
      runId: `run-${claimId}`,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
  }

  it("skips reporting snapshots while suspension is disabled and reports when it becomes enabled", async () => {
    const snapshots = vi.spyOn(placements, "readChangeSnapshot");
    const changed = vi.fn();
    const unsubscribe = sessionChanges.subscribe(changed);
    const reportChanges = createGatewayWorkerPlacementChangePublisher({
      placements,
      getSessionChangeContext: () => ({
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
      }),
      warn: vi.fn(),
    });
    try {
      const { harness, idleSweep, profile } = createIdleFixture({
        suspendAfter: null,
        reportChanges,
      });
      await harness.service.dispatch(REQUEST);
      nowMs += 60_000;
      changed.mockClear();
      await idleSweep.sweep();
      expect(snapshots).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");

      profile.suspendAfter = "1m";
      await idleSweep.sweep();
      expect(snapshots).toHaveBeenCalledTimes(2);
      expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
      expect(changed).toHaveBeenCalledWith({
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      });
    } finally {
      unsubscribe();
    }
  });

  it("starts the idle clock at the latest authoritative turn-claim release", async () => {
    const { harness, idleSweep } = createIdleFixture();
    await harness.service.dispatch(REQUEST);

    nowMs += 50_000;
    const claim = await claimWorkerTurn("recent-turn");
    nowMs += 5_000;
    await placements.releaseTurn(claim);

    nowMs += 59_999;
    await idleSweep.sweep();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");

    nowMs += 1;
    await idleSweep.sweep();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each(["dispatch"] as const)(
    "does not suspend while the real coordinator owns an in-flight %s",
    async (kind) => {
      const { harness, idleSweep, info, warn } = createIdleFixture({
        isPlacementOperationInFlight: (sessionId) =>
          coordinated.isPlacementOperationInFlight(sessionId),
      });
      const active = await harness.service.dispatch(REQUEST);
      const operationStarted = createDeferredCore();
      const releaseOperation = createDeferredCore();
      const blockedOperation = async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
        return active;
      };
      const coordinated = coordinateWorkerPlacementDispatch(
        {
          ...harness.service,
          ...(kind === "dispatch" ? { dispatch: blockedOperation } : { move: blockedOperation }),
        },
        (_request, run) => run(),
      );
      const inFlight =
        kind === "dispatch"
          ? coordinated.dispatch(REQUEST)
          : coordinated.move({
              sessionId: active.sessionId,
              sessionKey: active.sessionKey,
              agentId: active.agentId,
              source: {
                generation: active.generation,
                environmentId: active.environmentId,
                ownerEpoch: active.activeOwnerEpoch,
              },
              target: { kind: "gateway" },
            });

      try {
        await operationStarted.promise;
        nowMs += 60_000;
        expect(coordinated.isPlacementOperationInFlight(active.sessionId)).toBe(true);

        await idleSweep.sweep();

        expect(placements.get(active.sessionId)?.state).toBe("active");
        expect(harness.environments.destroy).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        releaseOperation.resolve();
        await inFlight;
      }
      expect(coordinated.isPlacementOperationInFlight(active.sessionId)).toBe(false);
    },
  );

  it.each([
    { reason: "an active local turn", kind: "local-claim" },
    { reason: "an admitted turn before its worker claim exists", kind: "admitted-turn" },
  ] as const)("does not suspend when blocked by $reason", async ({ kind }) => {
    const getSessionWorkAdmissionCheck =
      kind === "admitted-turn" ? vi.fn(async () => () => true) : undefined;
    const { harness, idleSweep, info, warn } = createIdleFixture({ getSessionWorkAdmissionCheck });

    const active = await harness.service.dispatch({
      ...REQUEST,
      executionMode: kind === "local-claim" ? "remote-exec" : "worker-turn",
    });
    if (kind === "local-claim") {
      await placements.claimTurn({
        ...REQUEST,
        claimId: "busy-local-claim",
        runId: "busy-local-run",
        owner: {
          kind: "local",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
    }

    nowMs += 120_000;
    const expectedState = placements.get(REQUEST.sessionId)?.state;
    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)?.state).toBe(expectedState);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    if (getSessionWorkAdmissionCheck) {
      expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      expect(getSessionWorkAdmissionCheck).toHaveBeenCalledExactlyOnceWith({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      });
    }
  });

  it("abandons suspension silently when session work is admitted before reclaim begins", async () => {
    const hasSessionWork = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const getSessionWorkAdmissionCheck = vi.fn(async () => hasSessionWork);
    const { harness, idleSweep, info, warn } = createIdleFixture({
      getSessionWorkAdmissionCheck,
    });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(hasSessionWork).toHaveBeenCalledTimes(2);
    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks idle policy at drain %s admission",
    async (stage) => {
      const { harness, idleSweep, profile, info, warn } = createIdleFixture({
        getSessionWorkAdmissionCheck: async () => () => false,
      });
      const active = await harness.service.dispatch(REQUEST);
      nowMs += 60_000;
      let admissionReached = false;
      probe.admission(operationAdmission, (request, grant, admit) => {
        if (request.stage === stage) {
          admissionReached = true;
          profile.suspendAfter = undefined;
        }
        admit(request, grant);
      });
      await idleSweep.sweep();
      expect(admissionReached).toBe(true);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        generation: active.generation,
      });
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["activity"])(
    "rechecks %s after delayed automatic reclaim preparation",
    async (change) => {
      const reclaimStarted = createDeferredCore();
      const releaseReclaim = createDeferredCore();
      const { harness, idleSweep, profile, info, warn } = createIdleFixture({
        reclaim: async (request, authorize, beforeDrain) => {
          reclaimStarted.resolve();
          await releaseReclaim.promise;
          return harness.service.reclaim(request, authorize, beforeDrain);
        },
        getSessionWorkAdmissionCheck: async () => () => false,
      });
      const active = await harness.service.dispatch(REQUEST);
      nowMs += 60_000;
      const sweeping = idleSweep.sweep();
      try {
        await reclaimStarted.promise;

        if (change === "activity") {
          const claim = await claimWorkerTurn("turn-during-idle-reclaim-wait");
          nowMs += 1_000;
          await placements.releaseTurn(claim);
        } else {
          profile.suspendAfter = change === "disabled policy" ? undefined : "2m";
        }
        releaseReclaim.resolve();
        await sweeping;

        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          turnClaim: null,
          updatedAtMs: change === "activity" ? nowMs : active.updatedAtMs,
        });
        expect(harness.environments.destroy).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();

        profile.suspendAfter = "1m";
        nowMs += 60_000;
        await idleSweep.sweep();
        expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
      } finally {
        releaseReclaim.resolve();
        await Promise.allSettled([sweeping]);
      }
    },
  );

  it("finishes its owned drain without rechecking idle eligibility during teardown", async () => {
    let hasSessionWork = false;
    const { harness, idleSweep, info, warn } = createIdleFixture({
      getSessionWorkAdmissionCheck: async () => () => hasSessionWork,
    });
    await harness.service.dispatch(REQUEST);
    const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation();
    if (!startTunnel) {
      throw new Error("expected the fixture tunnel implementation");
    }
    vi.mocked(harness.environments.startTunnel).mockImplementationOnce(async (...args) => {
      expect(placements.get(REQUEST.sessionId)?.state).toBe("draining");
      hasSessionWork = true;
      return await startTunnel(...args);
    });
    nowMs += 60_000;

    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a failed reclaim once without immediately retrying provider teardown", async () => {
    const { harness, idleSweep, info, warn } = createIdleFixture({ destroyFails: true });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
