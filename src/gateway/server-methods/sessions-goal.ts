import {
  ErrorCodes,
  errorShape,
  validateSessionsGoalClearParams,
  validateSessionsGoalUpdateParams,
  type SessionsGoalClearParams,
  type SessionsGoalUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  mutateSessionGoal,
  SessionGoalOperationError,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../config/sessions/session-entry-current-check.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { captureSessionSharingMemoryFacts } from "../session-sharing-incognito.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import {
  resolveSessionSharingTargetAsync,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  SessionMutationAuthorization,
} from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

async function handleSessionGoalMutation(
  options: GatewayRequestHandlerOptions,
  request: SessionsGoalUpdateParams | (SessionsGoalClearParams & { action: "clear" }),
): Promise<void> {
  const { client, context, respond, sessionMutationAuthorization } = options;
  const method = request.action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
  let targetRead:
    | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
    | undefined;
  let targetReadTransferred = false;
  try {
    const resolvedAuthorization = options.sessionMutationAuthorization
      ? { authorization: options.sessionMutationAuthorization, error: null }
      : await resolveSessionMutationAuthorizationAsync({
          client,
          method,
          requestParams: request,
          context,
        });
    using authorization = {
      ...resolvedAuthorization,
      [Symbol.dispose]: () => {
        if (!sessionMutationAuthorization) {
          resolvedAuthorization.authorization?.release?.();
        }
      },
    };
    if (authorization.error) {
      respond(false, undefined, authorization.error);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, request.sessionKey, request.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const target = await resolveSessionSharingTargetAsync({
      cfg,
      sessionKey: request.sessionKey,
      agentId: requestedAgent.agentId,
    });
    if (!target || (request.sessionId && target.entry.sessionId !== request.sessionId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Session changed or was removed; refresh its Goal."),
      );
      return;
    }
    const sessionChanged = () =>
      new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before its Goal update; retry."),
      );
    const actorFacts = captureSessionSharingMemoryFacts(
      {
        agentId: target.agentId,
        sessionKey: target.storeKey,
        resolved: target,
      },
      () => {
        if (options.hasCurrentClientAuthority?.() === false) {
          throw sessionChanged();
        }
        options.sessionMutationCommitGuard?.();
        options.signal?.throwIfAborted();
      },
      false,
    );
    if (!actorFacts && !isIncognitoSessionKey(target.canonicalKey)) {
      targetRead = await captureSessionEntryCurrentCheckAsyncInternal({
        agentId: target.agentId,
        sessionKey: target.storeKey,
        storePath: target.storePath,
        fields: ["pluginOwnerId"],
        errorMessage: "Session changed before its Goal update; retry.",
      });
    }
    const assertRouting = captureSessionMutationRouting(cfg, sessionChanged, [request]);
    const assertTarget = (
      current: Awaited<ReturnType<typeof resolveSessionSharingTargetAsync>>,
    ) => {
      // Reset can keep the same session ID. Fence the lifecycle and resolved store as well.
      if (
        !current ||
        current.agentId !== target.agentId ||
        current.storePath !== target.storePath ||
        current.storeKey !== target.storeKey ||
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision
      ) {
        throw sessionChanged();
      }
      const ownershipError = resolvePluginSessionOwnershipError({
        action: "patch",
        entry: current.entry,
        key: current.canonicalKey,
        pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
      });
      if (ownershipError) {
        throw new SessionMutationAuthorizationChangedError(ownershipError);
      }
    };
    const assertCurrent = () => {
      options.sessionMutationCommitGuard?.();
      authorization.authorization?.assertCurrent();
      if (!actorFacts) {
        assertRouting(context.getRuntimeConfig());
      }
      targetRead?.source.assertScopeCurrent?.();
      assertTarget(
        actorFacts
          ? actorFacts.readCurrent().target
          : targetRead
            ? targetRead.entry
              ? { ...target, entry: targetRead.entry }
              : null
            : null,
      );
    };
    if (!actorFacts) {
      assertCurrent();
    }
    const source: SessionSourceAssertion = targetRead
      ? composeSessionSourceAssertion(
          [
            targetRead.source,
            captureExternalSessionCommitGuard(options.sessionMutationCommitGuard),
            captureExternalSessionCommitGuard(authorization.authorization?.assertCurrent),
          ],
          (assertSources) => {
            assertSources();
            assertCurrent();
          },
        )
      : Object.assign(assertCurrent, {
          async prepareSessionSource() {
            return { assertCurrent, checks: [] };
          },
        });
    const identity = {
      operationId: request.operationId,
      issuedAtMs: request.issuedAtMs,
      requestFingerprint: await fingerprintSessionGoalRequest({ method, ...request }),
      goalId: request.goalId,
    };
    if (!actorFacts) {
      assertCurrent();
    }
    const resumeAuthorization: SessionMutationAuthorization = {
      assertCurrent: source,
      assertTargetCurrent: source,
      takeRelease: () => {
        const releaseSharing =
          authorization.authorization?.takeRelease?.() ??
          authorization.authorization?.retain?.() ??
          authorization.authorization?.release;
        // The ACK ends this request; accepted chat keeps both current-source owners.
        targetReadTransferred = true;
        return () => {
          try {
            targetRead?.release();
          } finally {
            releaseSharing?.();
          }
        };
      },
    };
    if (request.action === "replace") {
      const { replaceExecutingSessionGoal } = await import("./sessions-goal-replace.js");
      await replaceExecutingSessionGoal({
        options,
        request,
        target,
        source,
        resumeAuthorization,
        requestFingerprint: identity.requestFingerprint,
      });
      return;
    }
    if (request.action === "resume") {
      const { handleSessionGoalResumeChat } = await import("./chat-send-handler.js");
      await handleSessionGoalResumeChat(
        {
          ...options,
          sessionMutationAuthorization: resumeAuthorization,
          params: {
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            sessionId: target.entry.sessionId,
            message: request.note
              ? `Continue pursuing the current goal.\nOperator note: ${request.note}`
              : "Continue pursuing the current goal.",
            idempotencyKey: request.operationId,
            deliver: false,
          },
        },
        { ...identity, action: "resume", ...(request.note ? { note: request.note } : {}) },
      );
      return;
    }
    const operation = (
      request.action === "edit"
        ? { ...identity, action: "edit", objective: request.objective }
        : {
            ...identity,
            action: request.action,
            ...("note" in request && request.note ? { note: request.note } : {}),
          }
    ) satisfies SessionGoalOperation;
    const committed = await runSessionMutation({
      target: captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: target.storeKey,
        agentId: target.agentId,
        incarnation: target.entry.sessionId,
      }),
      requiredSessionId: target.entry.sessionId,
      policy: "allow-live",
      assertCurrent: source,
      run: () =>
        mutateSessionGoal({
          agentId: target.agentId,
          sessionKey: target.storeKey,
          storePath: target.storePath,
          expectedSessionId: target.entry.sessionId,
          operation,
          assertCurrent: source,
        }),
    });
    if (!committed.replayed && committed.sessionEntry) {
      await publishCommittedSessionGoalChange(context, {
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        entry: committed.sessionEntry,
        actor: gatewayClientSessionCreator(client),
        summary: `goal ${request.action}`,
      });
    }
    respond(
      true,
      { ...committed.result, ...(committed.replayed ? { replayed: true } : {}) },
      undefined,
    );
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, error.error);
    } else if (error instanceof SessionGoalOperationError) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
          details: { code: "GOAL_OPERATION_REJECTED", reason: error.code },
        }),
      );
    } else {
      context.logGateway.warn(`Goal update failed: ${String(error)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Unable to update the Goal; retry the request."),
      );
    }
  } finally {
    if (!targetReadTransferred) {
      targetRead?.release();
    }
  }
}

export const sessionGoalHandlers: GatewayRequestHandlers = {
  "sessions.goal.update": defineValidatedGatewayHandler(
    "sessions.goal.update",
    validateSessionsGoalUpdateParams,
    (options) => handleSessionGoalMutation(options, options.params),
  ),
  "sessions.goal.clear": defineValidatedGatewayHandler(
    "sessions.goal.clear",
    validateSessionsGoalClearParams,
    (options) => handleSessionGoalMutation(options, { ...options.params, action: "clear" }),
  ),
};
