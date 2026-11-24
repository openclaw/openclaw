import {
  ErrorCodes,
  errorShape,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import type { AgentJobSession } from "../agent-turn/types.js";
import { isGatewayAdmin, withSessionSharingTarget } from "../session-sharing-policy.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { agentRunHandler } from "./agent-run-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
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
  const prepared = createAgentTurnService({ context, isWebchatConnect }).prepareWaitForTurn(params);
  let profiles: ReturnType<typeof prepareSessionSharingProfiles> | undefined;
  const canReadRun = async (
    run: Readonly<AgentJobSession> | undefined,
    options: { restored?: boolean; publish?: () => void },
  ) => {
    if (!gatewayClient?.authenticatedUserProfile || isGatewayAdmin(gatewayClient)) {
      options.publish?.();
      return true;
    }
    const preparedProfiles = await (profiles ??= prepareSessionSharingProfiles(gatewayClient));
    const cfg = context.getRuntimeConfig();
    const sharing = prepareProjectedSessionSharing({
      client: gatewayClient,
      cfg,
      profiles: preparedProfiles,
      isMember: () => false,
    });
    if (!options.restored && sharing.sessionCap !== "none" && sharing.sessionCap !== "invited") {
      options.publish?.();
      return true;
    }
    if (!run?.sessionKey) {
      return false;
    }
    return withSessionSharingTarget(
      { cfg, sessionKey: run.sessionKey, agentId: run.agentId },
      ({ target, members, assertCurrent }) => {
        assertCurrent();
        const currentSharing = prepareProjectedSessionSharing({
          cfg: context.getRuntimeConfig(),
          client: gatewayClient,
          profiles: preparedProfiles,
          isMember: (_target, id) => members.some((member) => member.identityId === id),
        });
        if (
          !target ||
          run.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
          (run.sessionId !== undefined && target.entry.sessionId !== run.sessionId) ||
          !currentSharing.canReadTarget(target)
        ) {
          return false;
        }
        options.publish?.();
        return true;
      },
    );
  };
  const observation = await prepared.wait((session) => canReadRun(session, { restored: true }));
  if (
    !(await canReadRun(observation.session, { publish: () => respond(true, observation.result) }))
  ) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agent run was not found"));
  }
};

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
  "agent.wait": agentWaitHandler,
};
