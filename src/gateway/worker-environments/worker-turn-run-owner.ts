import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  createSessionPlacementSettlementClosedAbortError,
} from "../../agents/run-termination.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { withSessionPlacementForcedTerminalSettlement } from "../../agents/session-placement-forced-terminal-settlement.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticOwnedToolActivity,
  markDiagnosticRunProgress,
} from "../../logging/diagnostic-run-activity.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  registerReplyOperationSuccessorBarrier,
  stopReplyOperationForRestart,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  assertSessionControllerOperation,
  isCurrentSessionControllerOperation,
  activeSessionOperations,
} from "../../sessions/session-controller.state.js";
import type { SessionWatchdogWait } from "../../sessions/session-controller.watchdog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import { assertWorkerTurnLiveEventInputAdmitted } from "./placement-turn-claim-events.js";
import { boundedWorkerError } from "./worker-error.js";

export type ActiveWorkerTurn = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  operation: ReplyOperation;
  beginExecution: () => void;
  signal: AbortSignal;
  settled: Promise<void>;
  isReplyDelivered: () => boolean;
  recoverTerminal?: (assertCurrent?: () => void) => Promise<string | undefined>;
  dispose: () => void;
};

export type WorkerTurnLiveEventOwner = {
  /** Host approval managers supply their accepted record expiry and live pending assertion. */
  beginApprovalWait: (
    deadlineAtMs: number,
    isPending: () => boolean,
  ) => SessionWatchdogWait | undefined;
  record: (event: WorkerLiveEventParams["event"]) => void;
  isCancelled: () => boolean;
  isCancelledFinishing: (request: WorkerLiveEventParams) => boolean;
};

type WorkerRunOwner = WorkerTurnLiveEventOwner & {
  claim: WorkerSessionTurnClaim;
};

// Projection of the admitting controller operation; the operation owns turn liveness.
const activeOwners = new WeakMap<ReplyOperation, WorkerRunOwner>();

export const isWorkerTerminalLiveEvent = (request: WorkerLiveEventParams): boolean =>
  request.event.kind === "lifecycle" &&
  (request.event.payload.phase === "finishing" ||
    request.event.payload.phase === "end" ||
    (request.event.payload.phase === "error" &&
      (request.event.payload.aborted === true ||
        request.event.payload.fallbackExhaustedFailure === true)));

export function prepareWorkerTurnAdmittedLiveEvent(
  identity: WorkerConnectionIdentity,
  request: WorkerLiveEventParams,
): WorkerLiveEventParams {
  try {
    assertWorkerTurnLiveEventInputAdmitted(identity);
    return request;
  } catch (error) {
    if (request.event.kind !== "lifecycle" || request.event.payload.phase !== "finishing") {
      throw error;
    }
    // Workers without approved input still settle their terminal receipt, without
    // persisting worker-controlled content before input admission.
    return {
      ...request,
      event: {
        kind: "lifecycle",
        payload: { phase: "finishing", endedAt: request.event.payload.endedAt, aborted: true },
      },
    };
  }
}

export async function prepareWorkerTurnReplyDelivery(
  previous: ActiveWorkerTurn | undefined,
  turn: Pick<SessionPlacementTurnParams, "runId" | "abortSignal">,
) {
  // Settlement can invalidate placement reads even after the reply has completed.
  if (previous?.isReplyDelivered() && previous.claim.runId !== turn.runId) {
    await raceNodeWorkerOperation(previous.settled, turn.abortSignal);
  }
  const reply = createDeferredCore<EmbeddedAgentRunResult>();
  let delivered = false;
  return {
    isDelivered: () => delivered,
    deliver(this: void, result: EmbeddedAgentRunResult) {
      delivered = true;
      reply.resolve(result);
    },
    wait(this: void, execution: Promise<EmbeddedAgentRunResult>) {
      void execution.catch((error: unknown) => {
        if (delivered) {
          logWarn(`Cloud worker background settlement failed: ${boundedWorkerError(error)}`);
        }
      });
      return Promise.race([reply.promise, execution]);
    },
  };
}

export async function createWorkerTurnRunOwner(params: {
  placements: WorkerSessionPlacementStore;
  claim: WorkerSessionTurnClaim;
  turn: SessionPlacementTurnParams;
  sessionKey: string;
  isReplyDelivered: () => boolean;
  assertCurrent?: () => void;
}): Promise<ActiveWorkerTurn> {
  const { claim: requestedClaim, turn, sessionKey } = params;
  const operation = turn.replyOperation;
  if (!operation) {
    throw new Error("Worker turn requires its admitted reply operation");
  }
  const lifecycleGeneration = turn.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const claimAuthority = await params.placements.prepareTurnClaimAuthority(requestedClaim);
  const claim = claimAuthority.claim;
  let cleanup = () => claimAuthority.release();
  try {
    const assertCurrent = () => {
      params.assertCurrent?.();
      turn.abortSignal?.throwIfAborted();
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !claimAuthority.isCurrent()
      ) {
        throw new Error("Worker turn authority changed while preparing its run owner");
      }
    };
    assertCurrent();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      operation.abortSignal,
      ...(turn.abortSignal ? [turn.abortSignal] : []),
      controller.signal,
    ]);
    let closed = false;
    const startedAtMs = Date.now();
    let executionDeadlineAtMs: number | undefined;
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      sessionId: claim.sessionId,
      sessionKey,
      runId: claim.runId,
      watchdogAttempt: operation.watchdog.attachAttempt({
        assertCurrent: () => {
          if (closed || signal.aborted || !claimAuthority.isCurrent()) {
            throw new Error("Worker attempt retired");
          }
          assertSessionControllerOperation(operation);
        },
      }),
    });
    const beginExecution = () => {
      assertCurrent();
      if (executionDeadlineAtMs === undefined) {
        executionDeadlineAtMs = Date.now() + turn.timeoutMs;
        diagnosticOwner.watchdogAttempt?.setExecutionDeadline(executionDeadlineAtMs);
      }
    };
    const cancel = (reason?: "user_abort" | "restart" | "superseded") => {
      controller.abort(
        reason === "restart"
          ? createAgentRunRestartAbortError()
          : reason === "superseded"
            ? createAgentRunSupersededAbortError()
            : undefined,
      );
    };
    const restartSignal = getGatewayRestartDrainSignal();
    // Restart drain stops the admitting operation; Stop then cancels this backend.
    const onRestart = () => {
      stopReplyOperationForRestart(operation);
    };
    const isCurrent = () =>
      activeOwners.get(operation) === owner &&
      isCurrentSessionControllerOperation(operation) &&
      isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
      claimAuthority.isCurrent();
    const owner: WorkerRunOwner = {
      claim,
      beginApprovalWait: (deadlineAtMs, isPending) =>
        diagnosticOwner.watchdogAttempt?.beginWait({
          kind: "approval",
          deadlineAtMs,
          isCurrent: () => !closed && !signal.aborted && isCurrent() && isPending(),
        }),
      isCancelled: () => signal.aborted && isCurrent(),
      isCancelledFinishing: (request) =>
        owner.isCancelled() &&
        request.runId === claim.runId &&
        request.runEpoch === claim.owner.ownerEpoch &&
        request.event.kind === "lifecycle" &&
        request.event.payload.phase === "finishing" &&
        request.event.payload.aborted === true,
      record: (event) => {
        if (signal.aborted || !isCurrent()) {
          return;
        }
        if (event.kind === "tool" && event.payload.phase !== "update") {
          markDiagnosticOwnedToolActivity(diagnosticOwner, {
            toolName: event.payload.name,
            toolCallId: event.payload.toolCallId,
            phase: event.payload.phase === "start" ? "start" : "end",
            deadlineAtMs: executionDeadlineAtMs,
          });
        } else {
          diagnosticOwner.watchdogAttempt?.progress(
            event.kind === "assistant" ? "semantic" : "transport",
            `worker:${event.kind}`,
          );
          markDiagnosticRunProgress({
            sessionId: claim.sessionId,
            sessionKey,
            runId: claim.runId,
            reason: `worker:${event.kind}`,
          });
        }
      },
    };
    const queueMessage = async () => {
      throw new Error("Cloud worker turns do not support message injection");
    };
    const handle = {
      kind: "embedded",
      runId: claim.runId,
      startedAtMs,
      diagnosticOwner,
      closeDiagnostics: () => {
        if (closed) {
          return;
        }
        restartSignal.removeEventListener("abort", onRestart);
        closed = true;
        claimAuthority.release();
        closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
        // Recovered admission can create a second owner for the same operation.
        if (activeOwners.get(operation) === owner) {
          activeOwners.delete(operation);
        }
      },
      queueMessage,
      messageInjection: { isAvailable: () => false, queueMessage },
      isStreaming: () => false,
      isStopped: () => closed || signal.aborted,
      isAborted: () => signal.aborted,
      isAbortable: () => !closed && !signal.aborted,
      isCompacting: () => false,
      cancel,
      abort: cancel,
    } satisfies EmbeddedAgentQueueHandle;
    const completion = createDeferredCore();
    let attachment: ReturnType<typeof attachActiveEmbeddedRun>;
    const settle = async () => {
      cancel();
      await completion.promise;
    };
    let disposed = false;
    cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      operation.detachBackend(handle);
      try {
        detachActiveEmbeddedRun(
          claim.sessionId,
          handle,
          sessionKey,
          turn.sessionFile,
          undefined,
          attachment,
        );
      } finally {
        try {
          handle.closeDiagnostics();
        } finally {
          completion.resolve();
        }
      }
    };
    if (restartSignal.aborted) {
      onRestart();
    } else {
      restartSignal.addEventListener("abort", onRestart, { once: true });
    }
    signal.throwIfAborted();
    assertCurrent();
    withSessionPlacementForcedTerminalSettlement(
      settle,
      () => {
        params.assertCurrent?.();
        if (
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          !claimAuthority.isCurrent()
        ) {
          throw createSessionPlacementSettlementClosedAbortError();
        }
        signal.throwIfAborted();
      },
      () => {
        attachment = attachActiveEmbeddedRun(
          claim.sessionId,
          handle,
          sessionKey,
          turn.sessionFile,
          turn.agentId,
          operation,
          lifecycleGeneration,
        );
      },
    );
    registerReplyOperationSuccessorBarrier({
      operation,
      sessionId: claim.sessionId,
      sessionKeys: [sessionKey],
      start: settle,
    });
    assertCurrent();
    signal.throwIfAborted();
    activeOwners.set(operation, owner);
    return {
      claim,
      sessionKey,
      operation,
      signal,
      beginExecution,
      settled: completion.promise,
      isReplyDelivered: params.isReplyDelivered,
      dispose: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Capture before buffering or notifying listeners: neither a reused run ID nor
// a replacement owner may receive an earlier turn's delayed live event.
export function captureWorkerTurnLiveEventOwner(
  identity: Pick<WorkerConnectionIdentity, "sessionId" | "turnClaim">,
): WorkerTurnLiveEventOwner | undefined {
  const claim = identity.turnClaim;
  if (!claim || claim.owner.kind !== "worker" || identity.sessionId !== claim.sessionId) {
    return undefined;
  }
  let owner: WorkerRunOwner | undefined;
  // Physical stores can share a session ID; the admitted claim selects its exact operation.
  for (const operation of activeSessionOperations()) {
    const candidate = activeOwners.get(operation);
    if (!candidate || !sameWorkerSessionTurnClaim(candidate.claim, claim)) {
      continue;
    }
    if (owner) {
      return undefined;
    }
    owner = candidate;
  }
  return owner;
}
