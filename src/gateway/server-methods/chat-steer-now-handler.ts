import {
  ErrorCodes,
  errorShape,
  validateChatSteerNowParams,
  type ChatSteerNowResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { sendSessionControllerSteerNow } from "../../sessions/session-controller.steer.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const METHOD = "chat.steerNow";

export const chatSteerNowHandlers: GatewayRequestHandlers = {
  [METHOD]: ({ params, respond, context, signal, sessionAccessAuthority }) => {
    if (!assertValidParams(params, validateChatSteerNowParams, METHOD, respond)) {
      return;
    }
    if (!sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Sending a pending steer now requires session write access.",
        ),
      );
      return;
    }
    const target = sessionAccessAuthority.target;
    if (params.sessionId !== target.sessionId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The conversation changed; reload before sending now.",
        ),
      );
      return;
    }
    try {
      signal?.throwIfAborted();
      sessionAccessAuthority.assertCurrent();
      const source = getRpcSourceForGateway(params.runId, context.resolveGatewayContext);
      let result: ChatSteerNowResult = { status: "settled", tools: [] };
      if (source) {
        const identity = getRpcSourceIdentity(source);
        result =
          identity.agentId === target.agentId &&
          identity.sessionKey === target.sessionKey &&
          identity.sessionId === target.sessionId
            ? sendSessionControllerSteerNow(source.input)
            : { status: "unavailable", tools: [] };
      }
      respond(true, result);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    }
  },
};
