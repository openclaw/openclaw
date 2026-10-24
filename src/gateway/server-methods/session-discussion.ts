import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionDiscussionInfoParams,
  validateSessionDiscussionInfoResult,
  validateSessionDiscussionOpenParams,
  validateSessionDiscussionOpenResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { getSessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { maybeGenerateSessionTitle } from "../dashboard-session-title.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { hasExplicitSessionName } from "../session-title-state.js";
import { withGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils-store.js";
import { formatForLog } from "../ws-log.js";
import { respondError } from "./response.js";
import { emitSessionTitleChanged } from "./session-change-event.js";
import { measureSessionCollaborationPhase } from "./sessions-collaboration-diagnostics.js";
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
  const warn = (error: unknown) =>
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(error)}`,
    );
  try {
    const cfg = params.context.getRuntimeConfig();
    const resolved = await withGatewaySessionStoreTarget(
      { cfg, key: params.sessionKey, agentId: params.agentId },
      (target) => ({
        target,
        entry: resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
        canonicalKey: target.canonicalKey,
        storePath: target.storePath,
      }),
    );
    const { entry } = resolved;
    const sessionId = entry?.sessionId;
    if (!entry || !sessionId || hasExplicitSessionName(entry)) {
      return;
    }

    const observedTitleRequest = maybeGenerateSessionTitle({
      cfg,
      agentId: resolved.target.agentId,
      entry,
      sessionId,
      // Canonical key keeps metadata writes and request dedup consistent when
      // the open request addresses the session through an alias key.
      sessionKey: resolved.canonicalKey,
      storePath: resolved.storePath,
      userMessage: "",
      onTitleStateChanged: () =>
        emitSessionTitleChanged(params.context, {
          sessionKey: resolved.canonicalKey,
          sessionId,
          agentId: resolved.target.agentId,
        }),
    }).catch((error: unknown) => {
      warn(error);
      return false;
    });
    // Late titles remain owned by generation; discussion open bounds only its wait.
    await raceWithTimeout(observedTitleRequest, DISCUSSION_TITLE_TIMEOUT_MS, () => false, {
      ref: false,
    });
  } catch (error) {
    // Titling is best-effort; provider open remains the authoritative operation.
    warn(error);
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
        const result = await measureSessionCollaborationPhase(`${method}.provider`, () =>
          provider[operation]({ sessionKey, agentId: requestedAgent.agentId }),
        );
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
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "session discussion provider failed",
        );
      }
    },
  );
}

export const sessionDiscussionHandlers: GatewayRequestHandlers = {
  "session.discussion.info": sessionDiscussionHandler("info"),
  "session.discussion.open": sessionDiscussionHandler("open"),
};
