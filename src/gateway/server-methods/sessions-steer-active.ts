import {
  ErrorCodes,
  errorShape,
  validateSessionsSteerActiveParams,
  validateSessionsSteerTargetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { handleActiveSteerChat } from "./chat-send-handler.js";
import {
  hasCurrentPersonalGatewaySource,
  resolveAuthenticatedPersonalGatewayProfileId,
} from "./gateway-personal-caller.js";
import { captureSessionActiveSteerTarget } from "./session-active-steer-target.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSteeringPerson(options: GatewayRequestHandlerOptions): string | undefined {
  const { client, context, sessionAccessAuthority, respond } = options;
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
    return undefined;
  }
  sessionAccessAuthority.assertCurrent();
  return profileId;
}

export const sessionSteerActiveHandlers: GatewayRequestHandlers = {
  "sessions.steerTarget": async (options) => {
    const { params, respond, context, sessionAccessAuthority } = options;
    if (
      !assertValidParams(
        params,
        validateSessionsSteerTargetParams,
        "sessions.steerTarget",
        respond,
      ) ||
      !requireSteeringPerson(options) ||
      !sessionAccessAuthority
    ) {
      return;
    }
    const { target } = sessionAccessAuthority;
    // Pin the controller's logical store scope to the same physical row the
    // session authority admitted, using the existing shared read owner.
    const projection = requireSessionRowProjection(context);
    const read = await prepareSessionSharingRead({
      cfg: context.getRuntimeConfig(),
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      projection,
    });
    try {
      sessionAccessAuthority.assertCurrent();
      const current = read.readCurrent(context.getRuntimeConfig()).target;
      const admitted = projection.sharingTarget({
        key: target.sessionKey,
        agentId: target.agentId,
      });
      if (
        !admitted ||
        !current ||
        current.storePath !== admitted.storePath ||
        current.canonicalKey !== target.sessionKey ||
        current.entry.sessionId !== target.sessionId
      ) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, "The steering target changed."));
        return;
      }
      const backend = captureSessionActiveSteerTarget({
        ...target,
        storePath: read.storageTarget.storePath,
      });
      respond(true, {
        target: backend?.runId ? { sessionId: target.sessionId, runId: backend.runId } : null,
      });
    } finally {
      read.release();
    }
  },
  "sessions.steerActive": async (options) => {
    const { params, respond, sessionAccessAuthority } = options;
    if (
      !assertValidParams(params, validateSessionsSteerActiveParams, "sessions.steerActive", respond)
    ) {
      return;
    }
    const profileId = requireSteeringPerson(options);
    if (!profileId || !sessionAccessAuthority) {
      return;
    }
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
