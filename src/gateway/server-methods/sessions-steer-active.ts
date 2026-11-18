import {
  ErrorCodes,
  errorShape,
  validateSessionsSteerActiveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { handleActiveSteerChat } from "./chat-send-handler.js";
import {
  hasCurrentPersonalGatewaySource,
  resolveAuthenticatedPersonalGatewayProfileId,
} from "./gateway-personal-caller.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionSteerActiveHandlers: GatewayRequestHandlers = {
  "sessions.steerActive": async (options) => {
    const { params, respond, client, context, sessionAccessAuthority } = options;
    if (
      !assertValidParams(params, validateSessionsSteerActiveParams, "sessions.steerActive", respond)
    ) {
      return;
    }
    const profileId = resolveAuthenticatedPersonalGatewayProfileId(client);
    if (
      !profileId ||
      !hasCurrentPersonalGatewaySource(client, context) ||
      client.internal?.senderAttribution ||
      !sessionAccessAuthority
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Active steering requires a current authenticated person with session write access.",
        ),
      );
      return;
    }
    sessionAccessAuthority.assertCurrent();
    if (sessionAccessAuthority.target.sessionId !== params.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "The conversation changed; reload before steering."),
      );
      return;
    }
    await handleActiveSteerChat(
      bindGatewayRequestHandlerMutationAuthority(
        options,
        {
          ...options,
          params: {
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            sessionId: params.sessionId,
            message: params.message,
            idempotencyKey: params.idempotencyKey,
            queueMode: "steer",
          },
        },
        undefined,
      ),
      { runId: params.runId, profileId },
    );
  },
};
