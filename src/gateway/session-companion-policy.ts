import {
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const SESSION_COMPANION_TOOLS = ["read", "sessions_history", "sessions_search"] as const;

/** Side chat uses its utility route when permitted, then the requester's configured default. */
export function resolveSessionCompanionModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}) {
  let selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    useUtilityModel: true,
  });
  if (!selection) {
    throw new Error("No utility model is configured for this session.");
  }
  const policy = params.operatorAuthority?.modelPolicy;
  if (policy && !policy.allows({ provider: selection.provider, model: selection.modelId })) {
    const permitted = policy.models[0];
    assertOperatorModelAllowed(params.operatorAuthority, permitted);
    selection = permitted
      ? resolveSimpleCompletionSelectionForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          modelRef: `${permitted.provider}/${permitted.model}`,
        })
      : null;
  }
  assertOperatorModelAllowed(
    params.operatorAuthority,
    selection ? { provider: selection.provider, model: selection.modelId } : undefined,
  );
  if (!selection) {
    throw new Error("No permitted model is configured for this session.");
  }
  return selection;
}
