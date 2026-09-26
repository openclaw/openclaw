import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionDiscussionInfoParams,
  validateSessionDiscussionInfoResult,
  validateSessionDiscussionOpenParams,
  validateSessionDiscussionOpenResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getSessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { maybeGenerateSessionTitle } from "../dashboard-session-title.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { hasExplicitSessionName } from "../session-title-state.js";
import { formatForLog } from "../ws-log.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const DISCUSSION_TITLE_TIMEOUT_MS = 10_000;

async function maybeGenerateTitleBeforeDiscussionOpen(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
}): Promise<void> {
  try {
    const cfg = params.context.getRuntimeConfig();
    const resolved = loadAccessorSessionEntryForGatewayTarget({
      cfg,
      key: params.sessionKey,
      agentId: params.agentId,
    });
    const { entry } = resolved;
    const sessionId = entry?.sessionId;
    if (!entry || !sessionId || hasExplicitSessionName(entry)) {
      return;
    }

    const titleRequest = maybeGenerateSessionTitle({
      cfg,
      agentId: resolved.target.agentId,
      entry,
      sessionId,
      // Canonical key keeps metadata writes and request dedup consistent when
      // the open request addresses the session through an alias key.
      sessionKey: resolved.canonicalKey,
      storePath: resolved.storePath,
      userMessage: "",
    });
    const observedTitleRequest = titleRequest.catch((error: unknown) => {
      params.context.logGateway.warn(
        `dashboard session title generation failed: ${formatForLog(error)}`,
      );
      return false;
    });
    let timeout: NodeJS.Timeout | undefined;
    let persisted: boolean;
    // Late titles remain owned by generation; discussion open bounds only its wait.
    try {
      persisted = await Promise.race([
        observedTitleRequest,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), DISCUSSION_TITLE_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (persisted) {
      // Mirror the dashboard first-turn path so session lists learn the new
      // title immediately instead of on their next full refresh.
      emitSessionsChanged(params.context, {
        sessionKey: resolved.canonicalKey,
        agentId: resolved.target.agentId,
        reason: "chat.title",
      });
    }
  } catch (error) {
    // Titling is best-effort; provider open remains the authoritative operation.
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(error)}`,
    );
  }
}

function sessionDiscussionHandler(operation: "info" | "open"): GatewayRequestHandler {
  const method = operation === "info" ? "session.discussion.info" : "session.discussion.open";
  const validateParams =
    operation === "info"
      ? validateSessionDiscussionInfoParams
      : validateSessionDiscussionOpenParams;
  const validateResult =
    operation === "info"
      ? validateSessionDiscussionInfoResult
      : validateSessionDiscussionOpenResult;
  return defineValidatedGatewayHandler(
    method,
    validateParams,
    async ({ params, respond, context }) => {
      const requestedAgent = resolveRequestedSessionAgentId(
        context.getRuntimeConfig(),
        params.sessionKey,
        params.agentId,
      );
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const provider = getSessionDiscussionProvider();
      if (!provider) {
        respond(true, { state: "none" }, undefined);
        return;
      }
      try {
        if (operation === "open") {
          await maybeGenerateTitleBeforeDiscussionOpen({
            context,
            sessionKey: params.sessionKey,
            agentId: requestedAgent.agentId,
          });
        }
        const sessionKey = resolveStoredSessionKeyForAgentStore({
          cfg: context.getRuntimeConfig(),
          agentId: requestedAgent.agentId,
          sessionKey: params.sessionKey,
        });
        const result = await provider[operation]({ sessionKey, agentId: requestedAgent.agentId });
        if (!validateResult(result)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `invalid ${method} result: ${formatValidationErrors(validateResult.errors)}`,
            ),
          );
          return;
        }
        respond(true, result, undefined);
      } catch (error) {
        // Only an absent provider means "none"; hiding a failed provider would suppress retries.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "session discussion provider failed",
          ),
        );
      }
    },
  );
}

export const sessionDiscussionHandlers: GatewayRequestHandlers = {
  "session.discussion.info": sessionDiscussionHandler("info"),
  "session.discussion.open": sessionDiscussionHandler("open"),
};
