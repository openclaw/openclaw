// Keep exact-run abort wiring independent from session-wide cancellation orchestration.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { releaseAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "./chat-abort.js";
import { abortQueuedChatTurnById, type QueuedChatTurnEntry } from "./chat-queued-turns.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  getWorkerInferenceSessionControl,
  type WorkerInferenceCancellation,
} from "./worker-environments/inference-control-internal.js";

export function createChatAbortOps(
  context: Omit<ChatAbortOps, "onRunAborted"> &
    Pick<GatewayRequestContext, "cancelRunBoundApprovals">,
): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
    onRunAborted: (runId) => {
      // Each manager retains the write; abort itself must not wait for SQLite.
      void context.cancelRunBoundApprovals?.(runId).catch(() => {});
    },
  };
}

export function captureWorkerInferenceForSession(params: {
  context: GatewayRequestContext;
  sessionId?: string;
  runId?: string;
}): WorkerInferenceCancellation | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  return getWorkerInferenceSessionControl(
    params.context.workerEnvironmentService,
  )?.captureSessionCancellation(sessionId, params.runId);
}

export function createCommittedInputWithdrawalRelease(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "chatQueuedTurns">;
  ops: ChatAbortOps;
  runId: string;
  controller: AbortController;
  active?: ChatAbortControllerEntry;
  queued?: QueuedChatTurnEntry;
  admittedEntry?: ChatAbortControllerEntry;
  isWithdrawn: () => boolean;
  releaseHold: () => void;
}): () => void {
  const { context, ops, runId, controller, active, queued, admittedEntry } = params;
  const activeTarget = active && {
    entry: active,
    sessionKey: active.sessionKey,
    sessionId: active.sessionId,
    agentId: active.agentId,
  };
  const queuedTarget = queued && {
    entry: queued,
    sessionKey: queued.sessionKey,
    sessionId: queued.sessionId,
    agentId: queued.agentId,
  };
  return () => {
    try {
      // Native commitment owns cancellation even if the requester expires or active custody retires.
      if (!params.isWithdrawn() || controller.signal.aborted) {
        return;
      }
      if (
        activeTarget &&
        context.chatAbortControllers.get(runId) === activeTarget.entry &&
        activeTarget.entry.controller === controller &&
        activeTarget.entry.sessionKey === activeTarget.sessionKey &&
        activeTarget.entry.sessionId === activeTarget.sessionId &&
        activeTarget.entry.agentId === activeTarget.agentId
      ) {
        abortChatRunById(ops, {
          runId,
          sessionKey: activeTarget.sessionKey,
          stopReason: "rpc",
        });
      }
      if (
        !controller.signal.aborted &&
        queuedTarget &&
        context.chatQueuedTurns.get(runId) === queuedTarget.entry &&
        queuedTarget.entry.controller === controller &&
        queuedTarget.entry.sessionKey === queuedTarget.sessionKey &&
        queuedTarget.entry.sessionId === queuedTarget.sessionId &&
        queuedTarget.entry.agentId === queuedTarget.agentId
      ) {
        abortQueuedChatTurnById(context.chatQueuedTurns, {
          runId,
          sessionKey: queuedTarget.sessionKey,
          stopReason: "rpc",
        });
      }
      if (!controller.signal.aborted && admittedEntry?.controller === controller) {
        // Native withdrawal owns only this captured producer, even after its slot is replaced.
        admittedEntry.abortStopReason = "rpc";
        if (admittedEntry.agentRunDelegatedAuthority) {
          releaseAgentRunDelegatedAuthority(admittedEntry.agentRunDelegatedAuthority);
        }
        controller.abort();
      }
    } finally {
      params.releaseHold();
    }
  };
}
