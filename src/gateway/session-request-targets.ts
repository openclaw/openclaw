// Runtime targets can consult run state; keep them out of session-sharing input helpers.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateAgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import { prepareAgentWaitForTurn } from "./agent-turn/agent-wait.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { isDirectSessionReadMethod } from "./session-method-policy.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";
import {
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";

/** Undefined means the request's complete session target set is not known. */
export function resolveSessionRequestTargets(params: {
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  connId?: string;
}): SessionMutationTarget[] | undefined {
  if (params.method === "agent.wait") {
    if (!validateAgentWaitParams(params.requestParams)) {
      return undefined;
    }
    const session = prepareAgentWaitForTurn(params.context, params.requestParams).session;
    return session ? [{ sessionKey: session.sessionKey, agentId: session.agentId }] : undefined;
  }
  const request = asOptionalRecord(params.requestParams);
  // These operations can select a transcript or destination absent from the sharing targets.
  if (
    (params.method === "agent" && normalizeOptionalString(request?.sessionId)) ||
    params.method === "sessions.fork" ||
    params.method === "sessions.move" ||
    (params.method === "sessions.create" && !normalizeOptionalString(request?.key))
  ) {
    return undefined;
  }
  const talk = resolveTalkSessionTargetInput(params.method, params.requestParams, params.connId);
  if (talk?.kind === "relay") {
    return [{ sessionKey: talk.target.canonicalKey, agentId: talk.target.agentId }];
  }
  if (isDirectSessionReadMethod(params.method)) {
    const targets = resolveDirectSessionTargets(params.method, params.requestParams);
    return targets.length ? targets : undefined;
  }
  return resolveSessionMutationTargets(params);
}
