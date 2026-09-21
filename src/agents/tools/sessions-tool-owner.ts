import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsAssignOwnerResult } from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

/** Assignment changes responsibility, but its agent identity must come from a live turn. */
export async function assignSessionToolOwner(
  params: Record<string, unknown>,
  options: {
    assignmentOnly: boolean;
    resolveTarget: (sessionKey: string | undefined) => Promise<{
      agentId: string;
      key: string;
      requesterAgentId: string;
      requesterSessionKey: string;
    }>;
    gatewayRequest: AgentToolGatewayRequestCaller;
  },
) {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  if (options.assignmentOnly && !assertCallerCurrent) {
    throw new ToolAuthorizationError("Non-owner assignment requires an admitted agent turn");
  }
  assertCallerCurrent?.("sessions.assignOwner");
  const ownerType = readToolStringParam(params, "ownerType", { required: true });
  const ownerId = normalizeOptionalString(
    readToolStringParam(params, "ownerId", { required: true }),
  );
  if ((ownerType !== "human" && ownerType !== "agent") || !ownerId) {
    throw new ToolInputError("assign_owner requires ownerType and ownerId");
  }
  const { agentId, key, requesterAgentId, requesterSessionKey } = await options.resolveTarget(
    normalizeOptionalString(readToolStringParam(params, "sessionKey")),
  );
  const result = await options.gatewayRequest<SessionsAssignOwnerResult>({
    method: "sessions.assignOwner",
    params: {
      key,
      ...(parseAgentSessionKey(key) ? {} : { agentId }),
      owner: { type: ownerType, id: ownerId },
    },
    agentToolCaller: { agentId: requesterAgentId, sessionKey: requesterSessionKey },
    ...(assertCallerCurrent ? { assertDispatchCurrent: assertCallerCurrent } : {}),
  });
  return jsonResult({
    status: "updated",
    sessionKey: result.key,
    owner: {
      type: result.owner.actor.type,
      id: result.owner.actor.id,
      ...(result.owner.actor.label ? { label: result.owner.actor.label } : {}),
    },
  });
}
