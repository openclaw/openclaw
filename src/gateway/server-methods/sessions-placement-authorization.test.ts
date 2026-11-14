import { expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
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
    const authorizationError = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.INVALID_REQUEST, "session participation changed"),
    );
    const authorization: SessionMutationAuthorization = {
      assertCurrent: vi.fn(),
      assertTargetCurrent: vi.fn(),
    };
    const operationStarted = createDeferredCore();
    const releaseOperation = createDeferredCore();
    const durableTransition = vi.fn();
    const transition = async (
      _request: unknown,
      onTransitionOrAuthorize?: () => void,
      authorize?: () => void,
    ) => {
      operationStarted.resolve();
      await releaseOperation.promise;
      (scenario.method === "reclaim" ? onTransitionOrAuthorize : authorize)?.();
      durableTransition();
    };
    const service = {
      dispatch: scenario.method === "dispatch" ? transition : vi.fn(),
      ...(scenario.method === "dispatch" ? {} : { [scenario.method]: transition }),
    };
    const placement =
      scenario.method === "dispatch"
        ? undefined
        : scenario.method === "reclaim" && scenario.failed
          ? { ...makeFailedPlacement(), environmentId: null }
          : {
              ...makeReclaimedPlacement(),
              state: "active" as const,
              recoveryError: null,
              terminalReason: null,
              terminalAtMs: null,
            };
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
    vi.mocked(authorization.assertCurrent).mockImplementation(() => {
      throw authorizationError;
    });
    releaseOperation.resolve();

    const name = JSON.stringify(scenario);
    await expect(operation, name).rejects.toBe(authorizationError);
    expect(durableTransition, name).not.toHaveBeenCalled();
  }
});
