// Keep exact-run abort wiring independent from session-wide cancellation orchestration.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatAbortOps } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureWorkerInferenceCancellation,
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
  return captureWorkerInferenceCancellation(
    params.context.workerEnvironmentService,
    sessionId,
    params.runId,
  );
}
