import {
  ErrorCodes,
  errorShape,
  validateAgentWaitParams,
  type AgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import type { AgentJobSession } from "../agent-turn/types.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const gatewayClient = client ?? null;
  const prepared = createAgentTurnService({ context, isWebchatConnect }).prepareWaitForTurn(
    params as AgentWaitParams,
  );
  const authorizeWait = (run: Readonly<AgentJobSession> | undefined) => {
    if (!gatewayClient?.authenticatedUserProfile || isGatewayAdmin(gatewayClient)) {
      return true;
    }
    const cfg = context.getRuntimeConfig();
    if (operatorSessionCap(gatewayClient, cfg) !== "none") {
      return true;
    }
    const target = run?.sessionKey
      ? resolveSessionSharingTarget({ cfg, sessionKey: run.sessionKey, agentId: run.agentId })
      : null;
    const visibilityFilter = createSessionListEntryFilter({ client: gatewayClient, cfg });
    if (
      !target ||
      run?.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
      (run?.sessionId !== undefined && target.entry.sessionId !== run.sessionId) ||
      visibilityFilter?.(target.storeKey, target.entry) === false
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agent run was not found"));
      return false;
    }
    return true;
  };
  if (!authorizeWait(prepared.session)) {
    return;
  }
  const observation = await prepared.wait();
  if (authorizeWait(observation.session)) {
    respond(true, observation.result);
  }
};
