import {
  ErrorCodes,
  errorShape,
  validateSessionsSteerActiveParams,
  validateSessionsSteerTargetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import {
  captureSessionSteeringTarget,
  matchesSessionSteeringSource,
  matchesSessionSteeringTarget,
} from "../../config/sessions/session-active-steer.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { handleActiveSteerChat } from "./chat-send-handler.js";
import {
  hasCurrentPersonalGatewaySource,
  resolveAuthenticatedPersonalGatewayProfileId,
} from "./gateway-personal-caller.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSteeringPerson(
  options: GatewayRequestHandlerOptions,
): { profileId: string } | undefined {
  const { client, context, sessionAccessAuthority, respond } = options;
  // Check once per request, including retries. Work admitted just before off may still deliver.
  if (readRuntimeConfig().gateway?.sessionControl?.steeringEnabled !== true) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "Active steering is disabled. Enable gateway.sessionControl.steeringEnabled explicitly.",
      ),
    );
    return undefined;
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
    return undefined;
  }
  sessionAccessAuthority.assertCurrent();
  return { profileId };
}

export const sessionSteerActiveHandlers: GatewayRequestHandlers = {
  "sessions.steerTarget": async (options) => {
    const { params, respond, context, sessionAccessAuthority } = options;
    if (
      !assertValidParams(params, validateSessionsSteerTargetParams, "sessions.steerTarget", respond)
    ) {
      return;
    }
    const person = requireSteeringPerson(options);
    if (!person || !sessionAccessAuthority) {
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
      if (!matchesSessionSteeringSource(target, current, admitted)) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, "The steering target changed."));
        return;
      }
      const backend = captureSessionSteeringTarget({
        ...target,
        storePath: read.storageTarget.storePath,
      });
      options.sessionMutationCommitGuard?.();
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
    const person = requireSteeringPerson(options);
    if (!person || !sessionAccessAuthority) {
      return;
    }
    if (!matchesSessionSteeringTarget(sessionAccessAuthority.target, params.sessionId)) {
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
      { runId: params.runId, profileId: person.profileId },
    );
  },
};
