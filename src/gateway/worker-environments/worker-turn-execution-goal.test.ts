import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { prepareAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { mutateSessionGoal } from "../../config/sessions/goals-operations.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as backoff from "../../infra/backoff.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { publishCommittedSessionGoalChange } from "../server-methods/session-goal-change.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  createWorkerTurnTunnel,
  credential,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn execution Goal admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);
  afterEach(resetGlobalHookRunner);

  it.each(["retry", "revoked", "reuse", "pause", "clear"] as const)(
    "retries only positive capacity admission refusal while preserving retained-slot reuse (%s)",
    async (change) => {
      await seedActivePlacement();
      setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
      const runId = "recovery-physical-wait";
      await patchSessionEntryCore(sessionTarget, () => ({
        status: "running",
        lifecycleRunId: runId,
        mainRestartRecovery: { cycleId: "physical-cycle", revision: 1, chargedAttempts: 1 },
        restartRecoveryRuns: [{ runId, lifecycleGeneration: getAgentEventLifecycleGeneration() }],
        ...(change === "pause" || change === "clear"
          ? {
              goal: {
                schemaVersion: 1 as const,
                id: "captured-capacity-goal",
                objective: "Finish this work",
                status: "active" as const,
                createdAt: 100,
                updatedAt: 100,
                tokenStart: 0,
                tokensUsed: 0,
                continuationTurns: 0,
              },
              restartRecoveryGoal: {
                id: "captured-capacity-goal",
                sessionId: SESSION_ID,
                capturedAtMs: 100,
              },
            }
          : {}),
      }));
      const sleeping = createDeferred();
      const release = createDeferred();
      const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
        sleeping.resolve();
        await release.promise;
      });
      const cfg = { session: { store: sessionTarget.storePath } };
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(createContext(), () => projection);
      context.getRuntimeConfig = () => cfg;
      context.getSessionEventSubscriberConnIds = () => new Set();
      const operator = await captureGatewayOperatorRunAuthority({
        context,
        client: createOperatorClient({ profileName: "capacity", scopes: ["operator.write"] }),
      });
      assert.ok(operator);
      const source = operator.authority;
      const onExecutionStarted = vi.fn();
      let available = 0;
      const stop = new WorkerRunnerCapacityError();
      let preparations = 0;
      const acquireTurnCredential = vi.fn(async () => {
        if (++preparations === 2 && (change === "pause" || change === "clear")) {
          const committed = await mutateSessionGoal({
            ...sessionTarget,
            expectedSessionId: SESSION_ID,
            operation: {
              action: change,
              goalId: "captured-capacity-goal",
              operationId: `capacity-${change}`,
              issuedAtMs: Date.now(),
              requestFingerprint: `capacity-${change}`,
            },
            assertCurrent: source.assertCurrent,
          });
          assert.ok(committed.sessionEntry);
          await publishCommittedSessionGoalChange(context, {
            sessionKey: SESSION_KEY,
            agentId: "main",
            entry: committed.sessionEntry,
            summary: `goal ${change}`,
          });
          await projection.prepareMembership();
          // Public publication refreshes sharing, but pause/clear preserves actor and
          // session authority. Recovery intent must be checked separately at launch.
          expect(() => source.assertCurrent()).not.toThrow();
        }
        return credential();
      });
      let launches = 0;
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
        await request.beforeLaunch?.();
        request.onDispatchReady?.();
        if (++launches === 1 && change !== "reuse") {
          throw new WorkerRunnerCapacityError({
            launchId: request.plan.assignment.turnId,
            planHash: "a".repeat(64),
            environmentId: ENVIRONMENT_ID,
            sessionId: SESSION_ID,
            ownerEpoch: OWNER_EPOCH,
            placementGeneration: request.turnClaim.placementGeneration,
            runId,
            nodeDeviceId: "capacity-node",
            connId: "capacity-connection",
            pairingGeneration: "capacity-pairing",
          });
        }
        await request.onExecutionAccepted?.();
        throw stop;
      });
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      });
      const environments = {
        ...unusedEnvironments(),
        get: () => ({ ...attachedEnvironment(), nodeDeviceId: "capacity-node", sshEndpoint: null }),
        acquireTurnCredential,
        acknowledgeCredentialDelivery: vi.fn(async () => true),
        startTunnel: vi.fn(async () => tunnel),
      };
      bindDeviceWorkerAvailability(environments, async () => ({
        available: true,
        node: {
          nodeId: "capacity-node",
          connId: "capacity-connection",
          pairingIdentity: "capacity-identity",
          pairingGeneration: "capacity-pairing",
          clientId: "node-host",
          clientMode: "node",
          protocolFeature: "node-worker-supervisor-v6",
          workerHost: { enabled: true, capacity: { total: 1, available } },
          commands: [],
        },
      }));
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const input = turn(runId);
      const preparedRunAdmission = prepareAgentRunAdmission({
        cfg: input.config,
        operationalRunInstance: input.preparedRunAdmission.operationalRunInstance,
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "worker", boundary: "test.worker-turn", state: "present" },
        },
        assertSourceCurrent: source.assertCurrent,
        operatorAuthority: source,
      });
      const operation = withSessionPlacementTurnAdmission(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
        {
          ...input,
          onExecutionStarted,
          preparedRunAdmission,
        },
        vi.fn(),
      ).catch((error: unknown) => error);
      try {
        if (change === "reuse") {
          expect(await operation).toBe(stop);
          expect(sleep).not.toHaveBeenCalled();
          expect(onExecutionStarted).toHaveBeenCalledOnce();
          expect(launchTurn).toHaveBeenCalledOnce();
          return;
        }
        await awaitGateBeforeSettlement(
          sleeping.promise,
          operation,
          "native entry settled before capacity wait",
        );
        expect(onExecutionStarted).not.toHaveBeenCalled();
        expect(acquireTurnCredential).toHaveBeenCalledOnce();
        expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(runId);
        if (change === "revoked") {
          const owned = placements.get(SESSION_ID);
          const ownedClaim = owned ? projectWorkerSessionTurnClaim(owned) : undefined;
          assert.ok(ownedClaim);
          await placements.releaseTurn(ownedClaim);
        }
        available = 1;
        release.resolve();
        if (change === "retry") {
          expect(await operation).toBe(stop);
          expect(onExecutionStarted).toHaveBeenCalledOnce();
          expect(acquireTurnCredential).toHaveBeenCalledTimes(2);
          expect(launchTurn).toHaveBeenCalledTimes(2);
          expect(launchTurn.mock.calls[0]?.[0].turnClaim.claimId).not.toBe(
            launchTurn.mock.calls[1]?.[0].turnClaim.claimId,
          );
        } else {
          expect(await operation).toBeInstanceOf(Error);
          expect(onExecutionStarted).not.toHaveBeenCalled();
          expect(acquireTurnCredential).toHaveBeenCalledTimes(change === "revoked" ? 1 : 2);
          expect(launches).toBe(1);
        }
        expect(placements.get(SESSION_ID)?.state).toBe("active");
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await operation;
        uninstall();
        preparedRunAdmission.close();
        input.preparedRunAdmission.close();
        operator.release();
        projection.dispose();
        sleep.mockRestore();
      }
    },
  );
});
