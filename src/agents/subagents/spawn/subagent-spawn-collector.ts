import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { getCanonicalGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  runWithGatewayDetachedWorkContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import {
  completeCollectorLaunchCleanup,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "../registry/subagent-registry.js";
import type { SubagentRegistrationScope } from "../registry/subagent-registry.types.js";
import { holdQueuedSwarmRun, type activateSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  type bindSubagentSpawnCleanup,
  type cleanupFailedSpawnBeforeAgentStart,
  retrySubagentCleanup,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";
import type { PreparedContextEngineSubagentSpawn } from "./subagent-spawn-context.js";
import { readGatewayRunId } from "./subagent-spawn-gateway.js";
import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";

type CollectorLaunchCallbacks = Pick<
  Parameters<typeof activateSwarmRun>[0],
  "start" | "onStartFailure" | "onRemoved" | "signal"
>;

/** Hands preparation cleanup to its reservation before registration can wait on Stop. */
export function createCollectorPreparationHold(params: {
  runId?: string;
  gatewayContextResolver?: GatewayContextResolver;
}) {
  const removal = params.runId
    ? createDeferredCore<CollectorLaunchCallbacks["onRemoved"]>()
    : undefined;
  const reservation =
    params.runId && removal
      ? holdQueuedSwarmRun(params.runId, {
          onRemoved: removal.promise,
          lifecycleOwner: params.gatewayContextResolver
            ? getCanonicalGatewayContextResolver(params.gatewayContextResolver)
            : undefined,
        })
      : undefined;
  let handedOff = false;
  let releaseAuthority: (() => void) | undefined;
  const release = () => {
    const retained = releaseAuthority;
    releaseAuthority = undefined;
    retained?.();
  };
  return {
    reservation,
    retainAuthority: (retained: (() => void) | undefined) => {
      releaseAuthority = retained;
    },
    releaseAuthority: release,
    prepared(
      preparation: PreparedContextEngineSubagentSpawn | undefined,
      isCurrent: () => boolean,
    ) {
      if (!removal) {
        return;
      }
      handedOff = true;
      removal.resolve(async (reason) => {
        try {
          if (reason === "shutdown" || !isCurrent()) {
            await preparation?.dispose();
          } else {
            await preparation?.rollback();
          }
        } finally {
          release();
        }
      });
    },
    finish() {
      if (!handedOff) {
        release();
        removal?.resolve(undefined);
      }
    },
  };
}

/** Owns registered collector launch and settlement while the caller retains its FIFO reservation. */
export function createCollectorLaunchCallbacks(params: {
  childRunId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  gatewayContextResolver?: GatewayContextResolver;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  releaseOperatorAuthority?: () => void;
  cleanupOwner?: ReturnType<typeof bindSubagentSpawnCleanup>;
  registrationScope?: SubagentRegistrationScope;
  preparation?: PreparedContextEngineSubagentSpawn;
  provisionalSessionIdentity: {
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  };
  launchChildRun: (
    assertDispatchCurrent: () => void,
  ) => Promise<{ response: Parameters<typeof readGatewayRunId>[0] }>;
  recordParticipant: () => void;
  emitSpawnLifecycleHooks: (runId: string) => Promise<void>;
  cleanupFailedSpawn: (
    waitForSessionDeletion?: boolean,
  ) => ReturnType<typeof cleanupFailedSpawnBeforeAgentStart>;
}): CollectorLaunchCallbacks {
  const {
    childRunId,
    childSessionKey,
    gatewayContextResolver,
    registrationScope,
    preparation,
    provisionalSessionIdentity,
  } = params;
  const canLaunchQueuedRegistration = registrationScope?.canLaunch;
  const canCleanupCreatedSession =
    params.cleanupOwner?.isCurrent ?? registrationScope?.canCleanupSession;
  const callCleanupGateway = params.cleanupOwner?.callGateway;
  let releaseOperatorAuthority = params.releaseOperatorAuthority;
  const releaseAuthority = () => {
    const release = releaseOperatorAuthority;
    releaseOperatorAuthority = undefined;
    release?.();
  };
  let launchTerminationConfirmed = false;
  let dispatchAttempted = false;
  const startOnce = async () => {
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      for (
        let claim = registrationScope?.waitForClaim();
        claim;
        claim = registrationScope?.waitForClaim()
      ) {
        await claim;
      }
      const assertLaunchCurrent = () => {
        params.operatorAuthority?.assertCurrent();
        if (canLaunchQueuedRegistration?.() === false) {
          throw new Error("Collector registration no longer owns this launch");
        }
      };
      assertLaunchCurrent();
      dispatchAttempted = true;
      const launch = await params.launchChildRun(assertLaunchCurrent);
      // Queued registration already owns the task row before either dispatch route starts.
      // Out-of-process Gateway tracking finds that exact runId and suppresses its CLI row.
      const gatewayRunId = readGatewayRunId(launch.response) ?? childRunId;
      if (registrationScope?.canAcceptLaunch() === false) {
        await terminateAcceptedCollectorRun({
          childSessionKey,
          gatewayRunId,
          ...provisionalSessionIdentity,
          isCurrent: canCleanupCreatedSession,
          ...(callCleanupGateway ? { callGateway: callCleanupGateway } : {}),
          sessionCleanup: "preserve",
        });
        launchTerminationConfirmed = true;
        throw new Error("Collector registration changed during launch");
      }
      params.recordParticipant();
      try {
        const started = gatewayContextResolver
          ? startQueuedSubagentRun(childRunId, gatewayRunId, undefined, gatewayContextResolver)
          : startQueuedSubagentRun(childRunId, gatewayRunId);
        if (!started) {
          throw new Error("collector registry row could not transition from queued to running");
        }
      } catch (error) {
        await terminateAcceptedCollectorRun({
          childSessionKey,
          gatewayRunId,
          ...provisionalSessionIdentity,
          isCurrent: canCleanupCreatedSession,
          ...(callCleanupGateway ? { callGateway: callCleanupGateway } : {}),
        });
        launchTerminationConfirmed = true;
        throw error;
      }
      await params.emitSpawnLifecycleHooks(gatewayRunId);
    }, "subagents:spawn");
    await preparation?.dispose().catch(() => {});
    releaseAuthority();
  };
  // Scheduler retries repeat settlement, never the launch or admitted cleanup.
  let startAttempt: Promise<void> | undefined;
  const cleanupOnce = async () =>
    await Promise.allSettled([
      Promise.resolve().then(() => preparation?.rollback()),
      params.cleanupFailedSpawn(
        // A launch RPC can fail after acceptance. Keep the FIFO slot until
        // deleting the child session proves no accepted run remains active.
        !launchTerminationConfirmed,
      ),
    ]);
  let cleanupAttempt: ReturnType<typeof cleanupOnce> | undefined;
  const cleanupSucceeded = ([contextRollback, sessionCleanup]: Awaited<
    ReturnType<typeof cleanupOnce>
  >) =>
    contextRollback.status === "fulfilled" &&
    sessionCleanup.status === "fulfilled" &&
    sessionCleanup.value.attachmentsRemoved &&
    sessionCleanup.value.sessionDeleted;
  const publishCleanupCompletion = (cleanup: Awaited<ReturnType<typeof cleanupOnce>>) => {
    if (cleanupSucceeded(cleanup) && canCleanupCreatedSession?.() !== false) {
      emitSessionLifecycleEvent({
        sessionKey: childSessionKey,
        reason: "delete",
        parentSessionKey: params.requesterSessionKey,
      });
      completeCollectorLaunchCleanup(childRunId);
    }
  };
  const settleLaunchFailure = async (error: unknown) => {
    if (error instanceof GatewayDrainingError) {
      return false;
    }
    const callerSignal = getAsyncWorkSignal();
    if (!dispatchAttempted && callerSignal?.aborted) {
      return false;
    }
    return await runWithGatewayDetachedWorkContinuation(async () => {
      for (;;) {
        if (!dispatchAttempted && callerSignal?.aborted) {
          return false;
        }
        const claim = registrationScope?.waitForClaim();
        if (!claim) {
          break;
        }
        await claim;
      }
      for (
        let publication = registrationScope?.waitForRetirementPublication();
        publication;
        publication = registrationScope?.waitForRetirementPublication()
      ) {
        await publication;
      }
      const launchError = summarizeSpawnError(error);
      const settleFailure = async () => {
        if (registrationScope) {
          await registrationScope.settleFailedLaunch(launchError);
          return;
        }
        await retrySubagentCleanup(async () => {
          settleFailedQueuedSubagentLaunch(childRunId, launchError);
          return true;
        });
      };
      if (!dispatchAttempted && registrationScope) {
        await settleFailure();
      }
      if (canCleanupCreatedSession?.() === false) {
        await preparation?.dispose().catch(() => {});
        if (dispatchAttempted || !registrationScope) {
          await settleFailure();
        }
        if (cleanupAttempt) {
          publishCleanupCompletion(await cleanupAttempt);
        }
        releaseAuthority();
        return true;
      }
      const cleanup = await (cleanupAttempt ??= cleanupOnce());
      if (dispatchAttempted || !registrationScope) {
        await settleFailure();
      }
      publishCleanupCompletion(cleanup);
      releaseAuthority();
      return true;
    }, "subagents:spawn-cleanup");
  };
  return {
    signal: params.operatorAuthority?.signal,
    start: () => (startAttempt ??= startOnce()),
    onStartFailure: settleLaunchFailure,
    onRemoved: async (reason) => {
      try {
        if (reason === "cancelled" && params.operatorAuthority?.signal?.aborted) {
          const [settlement] = await Promise.allSettled([
            settleLaunchFailure(params.operatorAuthority.signal.reason),
          ]);
          // Logical failure settlement can outlive cleanup ownership. Rejoin the
          // cached disposer so retained native resources never certify cancellation.
          try {
            await preparation?.dispose();
          } catch (error) {
            if (settlement.status === "rejected") {
              throw new AggregateError(
                [settlement.reason, error],
                "Collector source revocation settlement and disposal failed",
                { cause: error },
              );
            }
            throw error;
          }
          if (settlement.status === "rejected") {
            throw settlement.reason;
          }
          if (!settlement.value) {
            throw new Error("Collector source revocation settlement is pending");
          }
          const cleanup = cleanupAttempt && (await cleanupAttempt);
          if (!cleanup || !cleanupSucceeded(cleanup)) {
            const failed = cleanup?.find((result) => result.status === "rejected");
            if (failed) {
              throw failed.reason;
            }
            throw new Error("Collector source revocation cleanup is incomplete");
          }
        } else if (reason === "shutdown" || canCleanupCreatedSession?.() === false) {
          // Restart replays queuedLaunch without repeating its durable context preparation.
          await preparation?.dispose();
        } else {
          await preparation?.rollback();
        }
      } finally {
        releaseAuthority();
      }
    },
  };
}
