import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { REQUEST } from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import { createWorkerPlacementMoveService } from "../worker-environments/placement-move-service.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionMove,
  makeDispatchTestContext,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();

function activePlacement(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "active",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

describe("sessions.move abandonment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId,
        agentRuntimeOverride: "openclaw",
        worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
      path: "/repo",
    });
  });

  it.each([
    { name: "starts an active abandonment", joined: false },
    { name: "joins an exact draining abandonment retry", joined: true },
  ])("$name and returns local while remote settlement remains unresolved", async ({ joined }) => {
    const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
    const active = activePlacement();
    const draining = { ...active, state: "draining" as const, generation: 5 };
    const existing = joined ? draining : active;
    const local = {
      ...active,
      state: "local" as const,
      generation: 9,
      environmentId: null,
      activeOwnerEpoch: null,
      turnClaim: null,
    };
    const recordPlacementMoveError = vi.fn();
    const validateAbandonSource = vi.fn();
    let remoteSettlementObserved = false;
    const remoteSettlement = new Promise<void>(() => {});
    void remoteSettlement.then(() => {
      remoteSettlementObserved = true;
    });
    const intent = {
      operationId: "move:v1:rpc-abandon",
      sessionId,
      source,
      target: { kind: "gateway" as const },
      abandonSource: true,
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const moves = createWorkerPlacementMoveService({
      placements: {
        beginPlacementMove: () => ({ intent, placement: draining, joined }),
        get: () => existing,
        getPlacementMove: () => (joined ? intent : undefined),
        recordPlacementMoveError,
      } as never,
      environments: { get: () => undefined },
      runMoveBarrier: async (params) => {
        const begun = await params.begin();
        if (params.sourceDisposition !== "abandon") {
          throw new Error("placement move interrupted");
        }
        return begun;
      },
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource,
      abandonSource: vi.fn(async () => local as never),
      resolveDestination: vi.fn(),
    });

    const context = makeDispatchTestContext({
      getSessionEventSubscriberConnIds: () => {
        throw new Error("session subscribers unavailable");
      },
      workerPlacementDispatchService: { dispatch: vi.fn(), move: moves.move } as never,
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, existing]]),
      },
    });
    const respond = await invokeSessionMove(context, {
      expected: source,
      target: { kind: "gateway" },
      abandonSource: true,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        key: sessionKey,
        sessionId,
        placement: { state: "local", generation: 9 },
      },
      undefined,
    );
    expect(validateAbandonSource).toHaveBeenCalledTimes(joined ? 0 : 1);
    expect(readSessionsMutationVersion(context)).toBe(2);
    expect(recordPlacementMoveError).not.toHaveBeenCalled();
    expect(remoteSettlementObserved).toBe(false);
  });

  it("executes sessions.move RPC to abandon an offline paired device with an existing pending workspace result and restores local placement", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-rpc-abandon-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const harness = createHarness(database, placements);

    try {
      const active = await harness.service.dispatch(REQUEST);
      harness.markEnvironmentNodeDeviceId("device-1");
      seedAttachedPlacementEnvironment(database, {
        environmentId: active.environmentId,
        sessionId: active.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
        providerId: "device",
        profileId: "device:device-1",
        nodeDeviceId: "device-1",
      });

      const claim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "rpc-pending-claim",
        runId: "rpc-pending-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      placements.markWorkspaceResultPending(claim);
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);

      mocks.resolveTarget.mockReturnValue(
        makeSessionTarget(
          {
            sessionId: active.sessionId,
            agentRuntimeOverride: "openclaw",
            worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
          },
          active.sessionKey,
        ),
      );
      mocks.findLiveByOwner.mockReturnValue({
        id: "worktree-1",
        ownerKind: "session",
        ownerId: active.sessionKey,
        path: "/repo",
      });

      const context = makeDispatchTestContext({
        getSessionEventSubscriberConnIds: () => new Set(),
        workerPlacementDispatchService: harness.service,
        workerSessionPlacementService: {
          getMany: (ids) => {
            const map = new Map();
            for (const id of ids) {
              const p = placements.get(id);
              if (p) {
                map.set(id, p);
              }
            }
            return map;
          },
        },
      });

      const respond = await invokeSessionMove(context, {
        key: active.sessionKey,
        expected: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
        abandonSource: true,
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          key: active.sessionKey,
          sessionId: active.sessionId,
          placement: expect.objectContaining({ state: "local" }),
        },
        undefined,
      );

      expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
      expect(placements.validateTurnClaim(claim)).toBe(false);
      expect(placements.get(active.sessionId)).toMatchObject({ state: "local" });
      expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("completes persisted abandonment after gateway restart and restores local use via sessions.move recovery", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-rpc-restart-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const harness = createHarness(database, placements, { failMoveAfterBegin: true });

    try {
      const active = await harness.service.dispatch(REQUEST);
      harness.markEnvironmentNodeDeviceId("device-1");
      seedAttachedPlacementEnvironment(database, {
        environmentId: active.environmentId,
        sessionId: active.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
        providerId: "device",
        profileId: "device:device-1",
        nodeDeviceId: "device-1",
      });

      const claim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "restart-pending-claim",
        runId: "restart-pending-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      placements.markWorkspaceResultPending(claim);
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);

      mocks.resolveTarget.mockReturnValue(
        makeSessionTarget(
          {
            sessionId: active.sessionId,
            agentRuntimeOverride: "openclaw",
            worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
          },
          active.sessionKey,
        ),
      );
      mocks.findLiveByOwner.mockReturnValue({
        id: "worktree-1",
        ownerKind: "session",
        ownerId: active.sessionKey,
        path: "/repo",
      });

      const context = makeDispatchTestContext({
        getSessionEventSubscriberConnIds: () => new Set(),
        workerPlacementDispatchService: harness.service,
        workerSessionPlacementService: {
          getMany: (ids) => {
            const map = new Map();
            for (const id of ids) {
              const p = placements.get(id);
              if (p) {
                map.set(id, p);
              }
            }
            return map;
          },
        },
      });

      const respond = await invokeSessionMove(context, {
        key: active.sessionKey,
        expected: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
        abandonSource: true,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/move barrier interrupted/) }),
      );

      closeOpenClawStateDatabaseForTest();
      const restartedDb = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const restartedStore = createWorkerSessionPlacementStore({
        database: restartedDb,
        now: () => 2_000,
      });
      const restartedHarness = createHarness(restartedDb, restartedStore);
      restartedHarness.markEnvironmentNodeDeviceId("device-1");

      await restartedHarness.service.reconcile();

      expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
      expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(0);
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
      expect(restartedHarness.log).not.toContain("workspace:reconcile");
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
