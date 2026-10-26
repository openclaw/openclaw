import type { PreparedReplyRunAdmission } from "./get-reply-run-admission.js";
import { canUseReasoningState, createReplyReasoningVisibility } from "./reasoning-visibility.js";

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

export function prepareReplyRunReasoningVisibility(
  state: PreparedReplyRunAdmission,
  sessionKey: string | undefined,
  opts: PreparedReplyRunAdmission["context"]["params"]["opts"],
) {
  return opts?.reasoningVisibilityEnabled && opts.registerReasoningVisibilityCleanup && sessionKey
    ? createReplyReasoningVisibility(buildReplyRunReasoningParams(state, sessionKey))
    : undefined;
}
