// Commands gateway methods expose validated command listing for a resolved
// agent, provider, scope, and argument-detail request.
import {
  ErrorCodes,
  errorShape,
  validateCommandsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { buildCommandsListResult } from "./commands-list-result.js";
import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

/** Gateway handler for enumerating available chat/native commands. */
export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": defineValidatedGatewayMethod(
    "commands.list",
    validateCommandsListParams,
    async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      await withSessionDiscoveryAccess(
        {
          client,
          context,
          respond,
          signal,
          hasCurrentClientAuthority,
          sessionKey: params.sessionKey,
          agentId: resolved.agentId,
          changedError: errorShape(
            ErrorCodes.UNAVAILABLE,
            "Session changed while preparing its commands. Retry the request.",
          ),
        },
        (sessionEntry) =>
          buildCommandsListResult({
            cfg: resolved.cfg,
            agentId: resolved.agentId,
            provider: params.provider,
            scope: params.scope,
            includeArgs: params.includeArgs,
            sessionKey: params.sessionKey,
            sessionEntry,
          }),
      );
    },
  ),
};
