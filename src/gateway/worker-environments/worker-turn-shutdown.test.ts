import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { waitForGatewayActiveWork } from "../../infra/gateway-active-work.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  database,
  measureLaunchTurn,
  placements,
  root,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

const unexpected = (): never => {
  throw new Error("Unexpected shutdown recovery operation");
};

describe("worker turn Gateway shutdown", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    resetGatewayWorkAdmission();
    await cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
  });
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { reason: "stop (SIGTERM)", pending: false, resetBeforeSettlement: false },
    { reason: "restart", pending: false, resetBeforeSettlement: true },
    { reason: "restart", pending: true, resetBeforeSettlement: false },
  ] as const)(
    "retires $reason work without failing its placement (pending result: $pending)",
    async ({ reason, pending, resetBeforeSettlement }) => {
      await seedActivePlacement();
      const launched = createDeferred();
      const finish = createDeferred();
      let workerSignal: AbortSignal | undefined;
      const environment = {
        ...attachedEnvironment(),
        nodeDeviceId: "paired-worker",
        sshEndpoint: null,
      };
      const launchTurn = vi.fn<
        NonNullable<Awaited<ReturnType<WorkerTurnEnvironmentService["startTunnel"]>>["launchTurn"]>
      >(async (request) => {
        request.onDispatchReady?.();
        workerSignal = request.signal;
        launched.resolve();
        await finish.promise;
        return {
          stdout: "",
          stderr: "worker admission deadline exceeded: Unexpected server response: 503",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: () => environment,
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runWorkspaceCommand: vi.fn(),
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          measureLaunchTurn,
          launchTurn,
        }),
        stopTunnel: vi.fn(async () => {}),
        destroy: vi.fn(async () => environment),
      };
      const reconcileActivePlacement = vi.fn(unexpected);
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        reconcileActivePlacement,
      });
      const rootAdmission = tryBeginGatewayRootWorkAdmission("test:worker-turn");
      if (!rootAdmission) {
        throw new Error("Expected root admission");
      }
      const runId = "interrupted-turn";
      const attempt = rootAdmission
        .run(() =>
          provider.executeTurn(
            { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            turn(runId),
            unexpected,
          ),
        )
        .catch((error: unknown) => error)
        .finally(() => rootAdmission.release());
      try {
        await launched.promise;
        const active = placements.get(SESSION_ID);
        const claim = active && projectWorkerSessionTurnClaim(active);
        if (!claim) {
          throw new Error("Expected live worker claim");
        }
        const authority = getWorkerTurnExecutionIdentityCapability(placements, claim);
        if (!authority) {
          throw new Error("Expected execution authority");
        }
        if (pending) {
          placements.markWorkspaceResultPending(claim);
        }
        markGatewayRestartDraining(reason);
        if (resetBeforeSettlement) {
          resetGatewayWorkAdmission();
        }
        finish.resolve();
        const error = await attempt;
        expect(isAgentRunRestartAbortReason(error)).toBe(true);
        expect(workerSignal?.aborted).toBe(true);
        await expect(authority.run(async () => "late tool")).rejects.toThrow();
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: "active",
          environmentId: ENVIRONMENT_ID,
          activeOwnerEpoch: OWNER_EPOCH,
          remoteWorkspaceDir: "/worker/workspace",
          turnClaim: { claimId: claim.claimId },
        });
        expect(placements.listPendingWorkspaceResults()).toHaveLength(pending ? 1 : 0);
        expect(environments.destroy).not.toHaveBeenCalled();
        expect(reconcileActivePlacement).not.toHaveBeenCalled();
        await expect(waitForGatewayActiveWork(0)).resolves.toMatchObject({ drained: true });
        expect(launchTurn).toHaveBeenCalledTimes(1);
        if (pending) {
          return;
        }

        resetGatewayWorkAdmission();
        const recovered = createWorkerSessionPlacementStore({ database });
        const recovery = createPlacementRecoveryActions({
          placements: recovered,
          environments: {
            ...environments,
            attachSession: unexpected,
            bindPreparedWorkspace: unexpected,
            prepareProjectIntent: unexpected,
            assertPreparedIntentCurrent: () => {
              throw new Error("Unexpected preparation");
            },
            getPreparedCandidates: () => [],
            schedulePreparedRefill: () => {},
            createWithRequest: unexpected,
            reconcileEnvironment: async () => {},
            reconcileOnce: async () => {},
            supportsProviderExecutionMode: () => true,
          },
          failure: {
            cancelProvisioning: unexpected,
            failActive: unexpected,
            failDraining: unexpected,
            reclaimActive: unexpected,
            retryFailedTeardown: unexpected,
            teardownEnvironment: unexpected,
          },
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          resolveWorkspace: async () => ({ kind: "local", path: root }),
          withPreparedRecovery: unexpected,
        });
        await recovery.reconcile("startup");
        expect(environments.stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
        expect(recovered.get(SESSION_ID)).toMatchObject({
          state: "active",
          turnClaim: null,
          environmentId: ENVIRONMENT_ID,
        });
        expect(recovered.validateTurnClaim(claim)).toBe(false);
        const nextLaunched = createDeferred();
        const cancelNext = new AbortController();
        launchTurn.mockImplementationOnce(async (request) => {
          request.onDispatchReady?.();
          expect(request.turnClaim.claimId).not.toBe(claim.claimId);
          expect(recovered.validateTurnClaim(request.turnClaim)).toBe(true);
          expect(request.signal?.aborted).toBe(false);
          nextLaunched.resolve();
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("next turn cancelled by user");
        });
        const next = createWorkerSessionTurnPlacementProvider({
          environments,
          placements: recovered,
        })
          .executeTurn(
            { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "next-turn" },
            { ...turn("next-turn"), abortSignal: cancelNext.signal },
            unexpected,
          )
          .catch((nextError: unknown) => nextError);
        await nextLaunched.promise;
        cancelNext.abort();
        await next;
        expect(launchTurn).toHaveBeenCalledTimes(2);
        expect(recovered.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await attempt;
      }
    },
  );
});
