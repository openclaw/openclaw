import type { PreparedReplyRunAdmission } from "./get-reply-run-admission.js";
import {
  canUseReasoningState,
  type createReplyReasoningVisibility,
} from "./reasoning-visibility.js";

export function buildReplyRunReasoningParams(
  { context: { params }, preparedSessionState }: PreparedReplyRunAdmission,
  sessionKey: string,
): Parameters<typeof createReplyReasoningVisibility>[0] {
  return {
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    sessionEntry: preparedSessionState.sessionEntry,
    authorized: canUseReasoningState(params.command, params.ctx.GatewayClientScopes),
    resolvedLevel: params.resolvedReasoningLevel,
    override: params.directives.reasoningLevel,
    abortSignal: params.opts?.abortSignal,
  };
}
