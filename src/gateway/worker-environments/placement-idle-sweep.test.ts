import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createGatewayWorkerPlacementChangePublisher } from "../server-worker-placement-change-events.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import { makeClaimInput } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { journalOwner } from "./placement-suite.test-support.js";
import { workspaceJournal } from "./workspace-manifest-fixtures.test-support.js";

const tempDirs = useStateDatabaseTempDirs();
type SweepOptions = Parameters<typeof createWorkerPlacementIdleSweep>[0];
type IdleFixtureOptions = Partial<
  Pick<
    SweepOptions,
    | "reportChanges"
    | "isPlacementOperationInFlight"
    | "loadSessionRuntime"
    | "getSessionWorkAdmissionCheck"
  >
> & {
  suspendAfter?: string | null;
  destroyFails?: boolean;
  reclaim?: SweepOptions["dispatch"]["reclaim"];
};

describe("worker placement idle suspension", () => {
  let nowMs: number;
  let database: OpenClawStateDatabase;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    nowMs = 1_000;
    const root = tempDirs.make("openclaw-worker-idle-sweep-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });
  afterEach(() => vi.restoreAllMocks());

  async function createIdleFixture(options: IdleFixtureOptions = {}) {
    const harness = await createHarness(database, placements, {
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
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const idleSweep = createWorkerPlacementIdleSweep({
      placements,
      environments: harness.environments,
      dispatch: { reclaim: options.reclaim ?? harness.service.reclaim },
      reportChanges: options.reportChanges ?? ((operation) => operation()),
      getConfig: () => ({ cloudWorkers: { profiles: { [REQUEST.profileId]: profile } } }),
      isPlacementOperationInFlight,
      loadSessionRuntime: options.loadSessionRuntime,
      getSessionWorkAdmissionCheck: options.getSessionWorkAdmissionCheck,
      info,
      warn,
    });
    const expectNotSuspended = () => {
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    };
    return { harness, idleSweep, profile, info, warn, expectNotSuspended };
  }

  it("reports enabled suspension at the activation deadline through real reclaim", async () => {
    const changed = vi.fn();
    const unsubscribe = sessionChanges.subscribe(changed);
    const reportChanges = createGatewayWorkerPlacementChangePublisher({
      placements,
      getSessionChangeContext: () => ({
        broadcastToConnIds: vi.fn(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
      }),
      warn: vi.fn(),
    });
    try {
      const { harness, idleSweep, profile, info, warn } = await createIdleFixture({
        suspendAfter: null,
        reportChanges,
      });
      const active = await harness.service.dispatch(REQUEST);
      nowMs += 60_000;
      changed.mockClear();
      await idleSweep.sweep();
      expect(changed).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");

      profile.suspendAfter = "2m";
      nowMs += 59_999;
      const sql = observeHostDataSql();
      try {
        await idleSweep.sweep();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      nowMs += 1;
      await idleSweep.sweep();
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
      });
      expect(changed).toHaveBeenCalledWith({
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      });
      expect(harness.environments.destroy).toHaveBeenCalledExactlyOnceWith(active.environmentId);
      expect(harness.log).toEqual(
        expect.arrayContaining([
          "placement:draining",
          "workspace:reconcile",
          "teardown:destroy",
          "placement:reclaimed",
        ]),
      );
      expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(REQUEST.sessionKey));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("cancels idle session preparation without waiting for a durable writer", async ({
    signal,
  }) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.dirname(database.path) };
    await upsertSessionEntryCore(
      { ...REQUEST, env },
      { sessionId: REQUEST.sessionId, updatedAt: 1 },
    );
    const sessionDatabase = openOpenClawAgentDatabase({ agentId: REQUEST.agentId, env });
    await closeOpenClawAgentDatabaseByPathAsync(sessionDatabase.path, REQUEST.agentId);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    let writer: Promise<void> | undefined;
    let writerSettled = false;
    const { harness, idleSweep, expectNotSuspended } = await createIdleFixture({
      loadSessionRuntime: async () => {
        writer = runWithSqliteDatabaseAdmissionTurn(
          [],
          () =>
            release.promise.then(() => {
              writerSettled = true;
            }),
          [path.dirname(sessionDatabase.path)],
        );
        return {
          resolveGatewaySessionStoreTargetInWorker(params) {
            const reading = resolveGatewaySessionStoreTargetInWorker({ ...params, env });
            entered.resolve();
            return reading;
          },
        };
      },
    });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;
    const sweeping = idleSweep.sweep(controller.signal);
    try {
      await withinTest(entered.promise, signal);
      controller.abort(new Error("idle preparation stopped"));
      await withinTest(sweeping, signal);
      expect(writerSettled).toBe(false);
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
      expectNotSuspended();
    } finally {
      release.resolve();
      await Promise.allSettled([writer, sweeping]);
      await closeOpenClawAgentDatabaseByPathAsync(sessionDatabase.path, REQUEST.agentId);
    }
    expect(writerSettled).toBe(true);
  });

  it("starts the idle clock at the latest authoritative turn-claim release", async () => {
    const { harness, idleSweep } = await createIdleFixture();
    const active = await harness.service.dispatch(REQUEST);

    nowMs += 50_000;
    const claim = await placements.claimTurn(
      makeClaimInput(active, "recent-turn", "run-recent-turn"),
    );
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

  it.each(["dispatch", "move"] as const)(
    "does not suspend while the real coordinator owns an in-flight %s",
    async (kind) => {
      const { harness, idleSweep, info, warn } = await createIdleFixture({
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
    { reason: "an active worker turn", kind: "worker-claim" },
    { reason: "an active local turn", kind: "local-claim" },
    { reason: "an admitted turn before its worker claim exists", kind: "admitted-turn" },
    { reason: "a durable pending result after its claim was revoked", kind: "pending-result" },
    { reason: "a durable workspace reconciliation journal", kind: "reconciling-result" },
    { reason: "a placement still provisioning", kind: "provisioning" },
    { reason: "a placement already draining", kind: "draining" },
  ] as const)("does not suspend when blocked by $reason", async ({ kind }) => {
    const getSessionWorkAdmissionCheck =
      kind === "admitted-turn" ? vi.fn(async () => () => true) : undefined;
    const { harness, idleSweep, expectNotSuspended } = await createIdleFixture({
      getSessionWorkAdmissionCheck,
    });

    if (kind === "provisioning") {
      await harness.placements.seedProvisioning();
    } else {
      const executionMode =
        kind === "local-claim" || kind === "pending-result" ? "remote-exec" : "worker-turn";
      const active = await harness.service.dispatch({ ...REQUEST, executionMode });
      if (kind === "worker-claim") {
        await placements.claimTurn(
          makeClaimInput(active, "busy-worker-claim", "run-busy-worker-claim"),
        );
      } else if (kind === "local-claim" || kind === "pending-result") {
        const claim = await placements.claimTurn(
          makeClaimInput(active, "busy-local-claim", "busy-local-run"),
        );
        if (kind === "pending-result") {
          await placements.markWorkspaceResultPending(claim);
          await placements.clearLocalTurnClaimsAfterRestartAsync();
          expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        }
      } else if (kind === "reconciling-result") {
        const basePack = Buffer.from("idle workspace journal");
        await placements.beginWorkspaceReconciliation(
          journalOwner(active),
          workspaceJournal(active.workspaceBaseManifestRef, `sha256:${"c".repeat(64)}`, {
            basePack,
          }),
        );
        expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      } else if (kind === "draining") {
        await placements.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      }
    }

    nowMs += 120_000;
    const expectedState = placements.get(REQUEST.sessionId)?.state;
    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)?.state).toBe(expectedState);
    expectNotSuspended();
    if (getSessionWorkAdmissionCheck) {
      expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      expect(getSessionWorkAdmissionCheck).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
        },
        undefined,
      );
    }
  });

  it("abandons suspension silently when session work is admitted before reclaim begins", async () => {
    const hasSessionWork = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const getSessionWorkAdmissionCheck = vi.fn(async () => hasSessionWork);
    const { harness, idleSweep, expectNotSuspended } = await createIdleFixture({
      getSessionWorkAdmissionCheck,
    });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(hasSessionWork).toHaveBeenCalledTimes(2);
    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });
    expectNotSuspended();
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks idle policy at drain %s admission",
    async (stage) => {
      const { harness, idleSweep, profile, expectNotSuspended } = await createIdleFixture({
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
      expectNotSuspended();
    },
  );

  it.each(["activity", "disabled policy", "longer timeout"])(
    "rechecks %s after delayed automatic reclaim preparation",
    async (change) => {
      const reclaimStarted = createDeferredCore();
      const releaseReclaim = createDeferredCore();
      const { harness, idleSweep, profile, expectNotSuspended } = await createIdleFixture({
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
          const claim = await placements.claimTurn(
            makeClaimInput(
              active,
              "turn-during-idle-reclaim-wait",
              "run-turn-during-idle-reclaim-wait",
            ),
          );
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
        expectNotSuspended();

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
    const { harness, idleSweep, info, warn } = await createIdleFixture({
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
    const { harness, idleSweep, info, warn } = await createIdleFixture({ destroyFails: true });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
