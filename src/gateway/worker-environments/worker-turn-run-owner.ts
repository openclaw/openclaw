import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  createSessionPlacementSettlementClosedAbortError,
} from "../../agents/run-termination.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { withSessionPlacementForcedTerminalSettlement } from "../../agents/session-placement-forced-terminal-settlement.js";
import { registerReplyOperationSuccessorBarrier } from "../../auto-reply/reply/reply-run-registry.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticOwnedToolActivity,
  markDiagnosticRunProgress,
} from "../../logging/diagnostic-run-activity.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";

export type ActiveWorkerTurn = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  signal: AbortSignal;
  recoverTerminal?: (assertCurrent?: () => void) => Promise<string | undefined>;
  dispose: () => void;
};

export type WorkerTurnLiveEventOwner = {
  record: (event: WorkerLiveEventParams["event"]) => void;
  isCancelled: () => boolean;
  isCancelledFinishing: (request: WorkerLiveEventParams) => boolean;
};

type WorkerRunOwner = WorkerTurnLiveEventOwner & {
  claim: WorkerSessionTurnClaim;
};

const activeOwners = new Map<string, WorkerRunOwner>();

export async function createWorkerTurnRunOwner(params: {
  placements: WorkerSessionPlacementStore;
  claim: WorkerSessionTurnClaim;
  turn: SessionPlacementTurnParams;
  sessionKey: string;
  assertCurrent?: () => void;
}): Promise<ActiveWorkerTurn> {
  const { claim: requestedClaim, turn, sessionKey } = params;
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
    const signal = turn.abortSignal
      ? AbortSignal.any([turn.abortSignal, controller.signal])
      : controller.signal;
    let closed = false;
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + turn.timeoutMs;
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      sessionId: claim.sessionId,
      sessionKey,
      runId: claim.runId,
    });
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
    const onRestart = () => cancel("restart");
    const isCurrent = () =>
      activeOwners.get(claim.sessionId) === owner &&
      isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
      claimAuthority.isCurrent();
    const owner: WorkerRunOwner = {
      claim,
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
            // The host owns this already-enforced run budget. A remote tool cannot
            // choose an exemption or extend its parent while provisioning a child.
            deadlineAtMs,
          });
        } else {
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
        if (activeOwners.get(claim.sessionId) === owner) {
          activeOwners.delete(claim.sessionId);
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
    const settle = async () => {
      cancel();
      // Cancellation must join write-capable preparation and possibly dispatched
      // work. Only the launcher's fenced read waits may detach their source.
      await completion.promise;
    };
    let disposed = false;
    cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      turn.replyOperation?.detachBackend(handle);
      try {
        clearActiveEmbeddedRun(claim.sessionId, handle, sessionKey, turn.sessionFile);
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
    setActiveEmbeddedRunLifecycleGeneration(handle, lifecycleGeneration);
    signal.throwIfAborted();
    turn.replyOperation?.attachBackend(handle);
    // Backend attachment can cancel synchronously; never replace the prior owner
    // until caller, lifecycle, and retained placement admission are still current.
    assertCurrent();
    signal.throwIfAborted();
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
      () =>
        setActiveEmbeddedRun(claim.sessionId, handle, sessionKey, turn.sessionFile, turn.agentId),
    );
    if (turn.replyOperation) {
      registerReplyOperationSuccessorBarrier({
        operation: turn.replyOperation,
        sessionId: claim.sessionId,
        sessionKeys: [sessionKey],
        start: settle,
      });
    }
    assertCurrent();
    signal.throwIfAborted();
    activeOwners.set(claim.sessionId, owner);
    return { claim, sessionKey, signal, dispose: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Capture before buffering or notifying listeners: neither a reused run ID nor
// a replacement owner may receive an earlier turn's delayed live event.
export function captureWorkerTurnLiveEventOwner(
  identity: WorkerConnectionIdentity,
): WorkerTurnLiveEventOwner | undefined {
  const owner = identity.sessionId ? activeOwners.get(identity.sessionId) : undefined;
  return owner &&
    identity.turnClaim?.owner.kind === "worker" &&
    sameWorkerSessionTurnClaim(owner.claim, identity.turnClaim)
    ? owner
    : undefined;
}
