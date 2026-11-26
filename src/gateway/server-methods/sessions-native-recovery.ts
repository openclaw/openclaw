import { isNativeAppUiClient } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  validateSessionsNativeRecoveryResumeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { acknowledgeNativeRestartRecovery } from "../../config/sessions/session-native-restart-recovery.js";
import { waitForAgentInputAdmission } from "../../state/agent-database-preparation-context.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import {
  resolveSessionSharingTargetAsync,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { respondError } from "./response.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const sessionNativeRecoveryHandlers: GatewayRequestHandlers = {
  "sessions.nativeRecovery.resume": defineValidatedGatewayHandler(
    "sessions.nativeRecovery.resume",
    validateSessionsNativeRecoveryResumeParams,
    async ({ params, client, signal, context, respond, sessionMutationAuthorization }) => {
      if (
        !client ||
        (!isOperatorUiClient(client.connect.client) &&
          !isNativeAppUiClient(client.connect.client)) ||
        client.internal?.syntheticClient ||
        client.internal?.senderAttribution
      ) {
        respondError(
          respond,
          ErrorCodes.FORBIDDEN,
          "Check what changed and select Resume in chat.",
        );
        return;
      }
      const admitted = sessionMutationAuthorization?.admittedTarget;
      if (!admitted) {
        respondError(
          respond,
          ErrorCodes.FORBIDDEN,
          "The selected session changed or is not writable.",
        );
        return;
      }
      const target = await resolveSessionSharingTargetAsync({
        cfg: context.getRuntimeConfig(),
        sessionKey: admitted.sessionKey,
        agentId: admitted.agentId,
      });
      if (!target) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          "The session changed. Refresh chat before resuming.",
        );
        return;
      }
      const scope = {
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: target.storeKey,
      };
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionMutationAuthorization.assertCurrent();
      };
      try {
        const result = await acknowledgeNativeRestartRecovery(
          scope,
          target.entry,
          params,
          admitted,
          assertCurrent,
        );
        if (result === "session-mismatch") {
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            "Select the current chat before resuming.",
          );
          return;
        }
        if (result !== "accepted") {
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            "This interruption is no longer held. Refresh chat.",
          );
          return;
        }
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          respond(false, undefined, error.error);
          return;
        }
        throw error;
      }
      // The acknowledgment transfers no authority to the queued inputs. The startup owner
      // releases them under their recorded senders, and can finish after an RPC disconnect.
      emitSessionsChanged(
        context,
        { sessionKey: target.canonicalKey, agentId: target.agentId, reason: "native-recovery" },
        { accessChanged: false },
      );
      try {
        await waitForAgentInputAdmission(scope.agentId, {
          ...scope,
          owner: context.agentDatabaseStartup,
        });
        respond(true, { queueReleased: true });
      } catch {
        respond(true, { queueReleased: false });
      }
    },
  ),
};
