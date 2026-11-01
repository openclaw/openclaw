import {
  ErrorCodes,
  errorShape,
  validateChatInterruptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { interruptForSessionControllerInput } from "../../sessions/session-controller.interrupt-input.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { captureRpcSourceScopeMatcher } from "../session-runtime-scope.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const METHOD = "chat.interrupt";

export const chatInterruptHandlers: GatewayRequestHandlers = {
  [METHOD]: async (options) => {
    const {
      params,
      respond,
      context,
      client,
      signal,
      sessionMutationAuthorization,
      sessionAccessAuthority,
    } = options;
    if (!assertValidParams(params, validateChatInterruptParams, METHOD, respond)) {
      return;
    }
    if (!sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Interrupting queued input requires session write access.",
        ),
      );
      return;
    }
    const target = sessionAccessAuthority.target;
    const authority = readGatewayRequestMutationAuthority(options);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      authority.assertCurrent();
      sessionMutationAuthorization?.assertCurrent();
      sessionAccessAuthority.assertCurrent();
    };
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    try {
      selection = await prepareChatHistorySessionRead({
        context,
        client,
        respond,
        signal,
        sessionMutationAuthorization,
        method: METHOD,
        sessionKey: params.sessionKey,
        agentIdOverride: params.agentId,
      });
      if (!selection) {
        return;
      }
      const { agentId, canonicalKey, storePath } = selection.selectedSession;
      assertCurrent();
      if (
        params.sessionId !== target.sessionId ||
        selection.entry?.sessionId !== target.sessionId ||
        agentId !== target.agentId ||
        canonicalKey !== target.sessionKey
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "The conversation changed; reload before interrupting queued input.",
          ),
        );
        return;
      }
      const source = getRpcSourceForGateway(params.runId, context.resolveGatewayContext);
      const identity = source && getRpcSourceIdentity(source);
      const matchesScope = captureRpcSourceScopeMatcher({
        storePath,
        resolveGatewayContext: context.resolveGatewayContext,
        physicalPaths: getSessionRowProjection(context)?.physicalPaths,
      });
      if (
        !source ||
        identity?.sessionId !== target.sessionId ||
        identity.sessionKey !== canonicalKey ||
        identity.agentId !== agentId ||
        !matchesScope(source)
      ) {
        respond(true, { status: "not_queued", runId: params.runId, cancellationRequested: false });
        return;
      }
      const result = interruptForSessionControllerInput(source.input, assertCurrent);
      respond(true, { ...result, runId: params.runId });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    } finally {
      selection?.release();
    }
  },
};
