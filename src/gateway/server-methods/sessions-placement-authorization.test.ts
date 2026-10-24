import { expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch,
  invokeSessionMove,
  invokeSessionReclaim,
  makeDispatchTestContext,
  makeFailedPlacement,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";
import type { SessionMutationAuthorization } from "./types.js";

const mocks = getDispatchTestMocks();
const activePlacement = (): WorkerSessionPlacementRecord => ({
  ...makeReclaimedPlacement(),
  state: "active",
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
});

it("rejects queued placement mutations after session participation is revoked", async () => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockReturnValue(
    makeSessionTarget({
      sessionId,
      agentRuntimeOverride: "openclaw",
      worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
    }),
  );
  mocks.findLiveByOwner.mockReturnValue({
    id: "worktree-1",
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const scenarios = [
    { method: "dispatch", target: { profileId: "test" } },
    { method: "dispatch", target: { deviceId: "device-1" } },
    { method: "move", target: { kind: "gateway" } },
    { method: "move", target: { kind: "profile", profileId: "test" } },
    { method: "move", target: { kind: "device", deviceId: "device-1" } },
    { method: "reclaim", failed: false },
    { method: "reclaim", failed: true },
  ] as const;
  const expected = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };

  for (const scenario of scenarios) {
    let participating = true;
    const authorizationError = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.INVALID_REQUEST, "session participation changed"),
    );
    const authorization: SessionMutationAuthorization = {
      assertCurrent: () => {
        if (!participating) {
          throw authorizationError;
        }
      },
      assertTargetCurrent: vi.fn(),
    };
    const operationStarted = createDeferredCore();
    const releaseOperation = createDeferredCore();
    const durableTransition = vi.fn();
    const afterWait = async (authorize?: () => void) => {
      operationStarted.resolve();
      await releaseOperation.promise;
      authorize?.();
      durableTransition();
    };
    const transition = vi.fn((_request, _onTransition, authorize?: () => void) =>
      afterWait(authorize),
    );
    const service =
      scenario.method === "dispatch"
        ? { dispatch: transition }
        : scenario.method === "move"
          ? { dispatch: vi.fn(), move: transition }
          : {
              dispatch: vi.fn(),
              reclaim: vi.fn((_request, authorize?: () => void) => afterWait(authorize)),
            };
    const placement =
      scenario.method === "dispatch"
        ? undefined
        : scenario.method === "reclaim" && scenario.failed
          ? { ...makeFailedPlacement(), environmentId: null }
          : activePlacement();
    const context = makeDispatchTestContext({
      workerPlacementDispatchService: service as never,
      workerSessionPlacementService: {
        getMany: () => new Map(placement ? [[sessionId, placement]] : []),
      },
    });

    const operation =
      scenario.method === "dispatch"
        ? invokeSessionDispatch(context, scenario.target, authorization)
        : scenario.method === "move"
          ? invokeSessionMove(context, { expected, target: scenario.target }, authorization)
          : invokeSessionReclaim(context, authorization);
    await operationStarted.promise;
    participating = false;
    releaseOperation.resolve();

    const name = JSON.stringify(scenario);
    await expect(operation, name).rejects.toBe(authorizationError);
    expect(durableTransition, name).not.toHaveBeenCalled();
  }
});
