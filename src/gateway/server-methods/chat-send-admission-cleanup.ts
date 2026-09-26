import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/** Own cleanup after chat admission transfers work beyond the request frame. */
export function createAdmittedChatSendCleanup(params: {
  cleanupAbort: () => void;
  releaseRetainedWork: () => void;
  releaseGatewayRoot: () => void;
}) {
  let discardPreparedMedia: (() => void) | undefined;
  return {
    cleanup: () => {
      params.cleanupAbort();
      params.releaseRetainedWork();
      params.releaseGatewayRoot();
      discardPreparedMedia?.();
      discardPreparedMedia = undefined;
    },
    setDiscardPreparedMedia: (discard: (() => void) | undefined) => {
      discardPreparedMedia = discard;
    },
  };
}

export function finishAbortedChatSend(params: {
  context: Pick<GatewayRequestContext, "dedupe">;
  respond: RespondFn;
  runId: string;
  lifecycleGeneration: string;
  stopReason?: string;
  sessionBinding: Parameters<typeof captureAgentJobSession>[0];
  cleanup: () => void;
}) {
  const endedAt = Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason ?? "rpc",
    endedAt,
  });
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    session: captureAgentJobSession(params.sessionBinding),
    entry: { ts: endedAt, ok: true, payload },
  });
  params.cleanup();
  clearAgentRunContext(params.runId, params.lifecycleGeneration);
  params.respond(true, payload, undefined, { runId: params.runId });
}
