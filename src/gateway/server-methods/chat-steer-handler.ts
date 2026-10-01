import {
  ErrorCodes,
  errorShape,
  validateChatSteerParams,
  type ChatSteerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isQueuedChatTurnForSession } from "../chat-queued-turns.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatSteerHandlers: GatewayRequestHandlers = {
  "chat.steer": async (options) => {
    const { params, context, respond, sessionMutationAuthorization } = options;
    if (!assertValidParams(params, validateChatSteerParams, "chat.steer", respond)) {
      return;
    }
    const authority = readGatewayRequestMutationAuthority(options);
    authority.assertCurrent();
    const cfg = context.getRuntimeConfig();
    const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return;
    }
    const sessionKey = resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: requested.agentId,
    });
    // The router owns participation, current profile, and incarnation admission.
    // Never reload a successor row or reconstruct a queued message from history.
    const target = sessionMutationAuthorization?.admittedTarget;
    if (
      !sessionMutationAuthorization ||
      !target ||
      target.agentId !== requested.agentId ||
      target.sessionKey !== sessionKey ||
      target.sessionId !== params.sessionId
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The conversation changed before steering. Refresh and try again.",
        ),
      );
      return;
    }
    const queued = context.chatQueuedTurns.get(params.runId);
    const ownsQueue = () =>
      context.chatQueuedTurns.get(params.runId) === queued &&
      isQueuedChatTurnForSession(context.chatQueuedTurns, params.runId, target);
    const reply = (result: ChatSteerResult) => respond(true, result);
    if (!queued || !ownsQueue()) {
      reply({ status: "not_queued" });
      return;
    }
    if (!queued.steer) {
      reply({
        status: "queued",
        reason: "This message cannot be steered right now. It remains queued.",
      });
      return;
    }
    const assertCurrent = () => {
      authority.assertCurrent();
      sessionMutationAuthorization.assertCurrent();
      if (!ownsQueue()) {
        throw new Error("The queued message changed before steering. Refresh the conversation.");
      }
    };
    assertCurrent();
    const result = await queued.steer(assertCurrent);
    authority.assertCurrent();
    reply(result);
  },
};
