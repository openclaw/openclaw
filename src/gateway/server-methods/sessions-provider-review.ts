import {
  ErrorCodes,
  errorShape,
  validateSessionsProviderReviewContinueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  issueProviderReviewAcknowledgment,
  readProviderReviewAcknowledgment,
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionProviderReviewHandlers: GatewayRequestHandlers = {
  "sessions.providerReview.continue": async (options) => {
    const { params, client, context, respond } = options;
    if (
      !assertValidParams(
        params,
        validateSessionsProviderReviewContinueParams,
        "sessions.providerReview.continue",
        respond,
      )
    ) {
      return;
    }
    if (
      !client ||
      !isOperatorUiClient(client.connect.client) ||
      client.internal?.syntheticClient ||
      client.internal?.senderAttribution
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Review and acknowledge the findings in chat."),
      );
      return;
    }
    let acknowledgment: ProviderReviewAcknowledgment | undefined;
    let handedOff = false;
    try {
      const authorization = options.sessionMutationAuthorization
        ? { authorization: options.sessionMutationAuthorization, error: null }
        : resolveSessionMutationAuthorization({
            client,
            method: "sessions.providerReview.continue",
            requestParams: params,
            context,
          });
      if (authorization.error) {
        respond(false, undefined, authorization.error);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      const target = resolveSessionSharingTarget({
        cfg,
        sessionKey: params.sessionKey,
        agentId: requested.agentId,
      });
      if (!target || target.entry.sessionId !== params.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "The session changed; refresh its findings."),
        );
        return;
      }
      // Accepted input retains its original operator authority independently of UI selection.
      const assertCurrent = () => {
        options.signal?.throwIfAborted();
        if (options.hasCurrentClientAuthority?.() === false) {
          throw new Error("Provider review caller authority is no longer current");
        }
        const assertAuthority =
          authorization.authorization?.assertAdmittedInputCurrent ??
          authorization.authorization?.assertCurrent;
        assertAuthority?.();
      };
      acknowledgment = await issueProviderReviewAcknowledgment({
        target: {
          agentId: target.agentId,
          storePath: target.storePath,
          sessionKey: target.storeKey,
          sessionId: target.entry.sessionId,
          lifecycleRevision: target.entry.lifecycleRevision,
        },
        reviewId: params.reviewId,
        nextRunId: params.idempotencyKey,
        assertCurrent,
      });
      const { review } = readProviderReviewAcknowledgment(acknowledgment);
      const message = review.review?.continuation?.message;
      if (message === undefined) {
        throw new Error("Provider review has no continuation");
      }
      const { handleProviderReviewContinuationChat } = await import("./chat-send-handler.js");
      assertCurrent();
      handedOff = true;
      await handleProviderReviewContinuationChat(
        {
          ...options,
          sessionMutationAuthorization: authorization.authorization,
          params: {
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            sessionId: target.entry.sessionId,
            message,
            idempotencyKey: params.idempotencyKey,
            deliver: false,
          },
        },
        acknowledgment,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
      } else {
        // Provider findings and continuation text must not become request diagnostics.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Could not continue this chat. Refresh its current findings before trying again.",
          ),
        );
      }
    } finally {
      if (acknowledgment && !handedOff) {
        retireProviderReviewAcknowledgment(acknowledgment);
      }
    }
  },
};
