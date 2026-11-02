import {
  ErrorCodes,
  errorShape,
  validateChatSteerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  isRpcSourceRegistered,
  isRpcSourceWaitingForTurn,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureRpcSourceScopeMatcher } from "../session-runtime-scope.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatSteerHandlers: GatewayRequestHandlers = {
  "chat.steer": async (options) => {
    const { params, context, respond, sessionAccessAuthority } = options;
    if (!assertValidParams(params, validateChatSteerParams, "chat.steer", respond)) {
      return;
    }
    if (!sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Steering queued inputs requires session write access."),
      );
      return;
    }
    const authority = readGatewayRequestMutationAuthority(options);
    authority.assertPreparationCurrent();
    const target = sessionAccessAuthority.target;
    const staleTarget = () =>
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The conversation changed before steering. Refresh and try again.",
        ),
      );
    if (target.sessionId !== params.sessionId) {
      staleTarget();
      return;
    }
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    try {
      selection = await prepareChatHistorySessionRead({
        context,
        client: options.client,
        respond,
        signal: options.signal,
        sessionMutationAuthorization: options.sessionMutationAuthorization,
        method: "chat.steer",
        sessionKey: params.sessionKey,
        agentIdOverride: params.agentId,
      });
      if (!selection) {
        return;
      }
      const { agentId, canonicalKey, storePath } = selection.selectedSession;
      if (
        agentId !== target.agentId ||
        canonicalKey !== target.sessionKey ||
        selection.entry?.sessionId !== target.sessionId
      ) {
        staleTarget();
        return;
      }
      const matchesScope = captureRpcSourceScopeMatcher({
        storePath,
        physicalPaths: selection.rowProjection.physicalPaths,
        resolveGatewayContext: context.resolveGatewayContext,
      });
      // Capture one exact source; neither aliases nor callbacks may select a successor.
      const source = getRpcSourceForGateway(params.runId, context.resolveGatewayContext);
      const matches = () => {
        if (!source || !isRpcSourceRegistered(source) || !matchesScope(source)) {
          return false;
        }
        const identity = getRpcSourceIdentity(source);
        return (
          identity.sessionKey === target.sessionKey &&
          identity.sessionId === target.sessionId &&
          identity.agentId === target.agentId
        );
      };
      if (
        !source ||
        !matches() ||
        !isRpcSourceWaitingForTurn(source) ||
        !source.input.custody.enqueued
      ) {
        respond(true, { status: "not_queued" }, undefined);
        return;
      }
      const steer = source.input.steerQueued;
      if (!steer) {
        respond(
          true,
          {
            status: "queued",
            reason: "This message is not ready for steering. It remains queued.",
          },
          undefined,
        );
        return;
      }
      const assertCurrent = () => {
        authority.assertCurrent();
        sessionAccessAuthority.assertCurrent();
        if (!matches()) {
          throw new Error("The queued input changed before steering. Refresh and retry.");
        }
      };
      assertCurrent();
      const result = await steer(assertCurrent);
      // Native commitment may already have retired this exact source.
      authority.assertPreparationCurrent();
      sessionAccessAuthority.assertCurrent();
      respond(true, result, undefined);
    } finally {
      selection?.release();
    }
  },
};
