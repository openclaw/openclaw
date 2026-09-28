import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createGatewayWorkerDispatchAdmission,
  createGatewayWorkerPlacementDrain,
} from "../server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementMoveBarrier } from "../server-worker-placement-move-barrier.js";
import type { WorkerPlacementSessionRuntime } from "../server-worker-placement-reclaim.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils.js";
import { coordinateWorkerPlacementDispatch } from "../worker-environments/placement-dispatch-coordinator.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import { placementTurnOwner } from "../worker-environments/placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../worker-environments/placement-test-fixtures.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionMove,
  makeDispatchTestContext,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();
const identity = { sessionId, sessionKey, agentId: "main" };

describe("placement drain rejects stale owners before interrupting session work", () => {
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;
  let storePath: string;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      cleanup();
    }),
  );
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    const root = tempDirs.make("openclaw-placement-drain-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database });
    storePath = path.join(root, "agent.sqlite");
    mocks.resolveTarget.mockReturnValue({
      ...makeSessionTarget({
        sessionId,
        agentRuntimeOverride: "openclaw",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: root },
      }),
      storePath,
    });
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
      path: root,
    });
  });

  function createCoordinator() {
    const runtime: WorkerPlacementSessionRuntime = {
      managedWorktrees: { findLiveByOwner: mocks.findLiveByOwner },
      resolveGatewaySessionStoreTargetWithStore: mocks.resolveTarget,
      resolveCanonicalSessionEntryFromStoreKeys,
    };
    const loadSessionRuntime = async () => runtime;
    const harness = createHarness(database, placements, {
      runMoveBarrier: createGatewayWorkerPlacementMoveBarrier({
        placements,
        loadSessionRuntime,
        revokeSessionAuthority: vi.fn(),
      }),
    });
    return coordinateWorkerPlacementDispatch(
      harness.service,
      createGatewayWorkerDispatchAdmission(loadSessionRuntime),
      undefined,
      undefined,
      createGatewayWorkerPlacementDrain(placements, loadSessionRuntime),
    );
  }

  async function admitCurrentTurn(state: "active" | "draining") {
    const active = await advancePlacementFixtureToActive(
      placements,
      database,
      { ...identity, executionMode: "worker-turn" },
      { ownerEpoch: 2 },
    );
    const claim = await placements.claimTurn({
      ...identity,
      owner: placementTurnOwner(active),
      claimId: "new-owner-claim",
      runId: "new-owner-run",
    });
    if (state === "draining") {
      placements.startDrain({
        sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
    }
    const before = placements.get(sessionId);
    const onInterrupt = vi.fn(() => {
      admission.release();
      // Fail-before proof must stop at the forbidden interruption, without a claim timeout.
      throw new Error("Unexpected interruption of the current owner's turn");
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {
        expect(placements.validateTurnClaim(claim)).toBe(true);
      },
      onInterrupt,
    });
    return { active, admission, before, claim, onInterrupt };
  }

  async function expectCurrentTurnUntouched(turn: Awaited<ReturnType<typeof admitCurrentTurn>>) {
    expect(turn.onInterrupt).not.toHaveBeenCalled();
    expect(placements.get(sessionId)).toEqual(turn.before);
    expect(placements.validateTurnClaim(turn.claim)).toBe(true);
    const next = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    next.release();
  }

  it.each(["active", "draining"] as const)(
    "sessions.move rejects a stale source while the newer owner is %s",
    async (state) => {
      const coordinated = createCoordinator();
      const turn = await admitCurrentTurn(state);
      try {
        const respond = await invokeSessionMove(
          makeDispatchTestContext({
            workerPlacementDispatchService: coordinated,
            workerSessionPlacementService: placements,
          }),
          {
            expected: {
              generation: turn.active.generation - 1,
              environmentId: turn.active.environmentId,
              ownerEpoch: turn.active.activeOwnerEpoch - 1,
            },
            target: { kind: "gateway" },
          },
        );
        await expectCurrentTurnUntouched(turn);
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: `Cannot move stale worker placement for session ${sessionId}`,
          }),
        );
      } finally {
        turn.admission.release();
      }
    },
  );

  it("dispatch rejects an active placement without interrupting its admitted turn", async () => {
    const coordinated = createCoordinator();
    const turn = await admitCurrentTurn("active");
    try {
      const result = await coordinated
        .dispatch({ ...identity, profileId: "test", executionMode: "worker-turn" })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await expectCurrentTurnUntouched(turn);
      expect(result).toEqual({
        error: new Error(`Cannot dispatch session ${sessionId} from placement active`),
      });
    } finally {
      turn.admission.release();
    }
  });
});
