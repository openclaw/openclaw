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
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "../../config/sessions/session-source-authority.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  captureIncognitoSessionMutationFacts,
  captureSessionActorMutationFacts,
} from "../session-sharing-incognito.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { prepareSessionSharingSource } from "../session-sharing-source.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTargetAsync,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

async function handleSessionGoalMutation(
  options: GatewayRequestHandlerOptions,
  request: SessionsGoalUpdateParams | (SessionsGoalClearParams & { action: "clear" }),
): Promise<void> {
  const { client, context, respond } = options;
  const method = request.action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
  try {
    const authorization = options.sessionMutationAuthorization
      ? { authorization: options.sessionMutationAuthorization, error: null }
      : await resolveSessionMutationAuthorization({
          client,
          method,
          requestParams: request,
          context,
        });
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
    const actorTarget = {
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
    };
    const memory = getSessionActorStorageBinding(actorTarget);
    const binding = memory ? undefined : captureIncognitoSessionBinding(actorTarget);
    const actorFacts = memory
      ? captureSessionActorMutationFacts(memory, target.storeKey, false)
      : binding && captureIncognitoSessionMutationFacts(binding, target.storeKey, false);
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
        entry: binding
          ? {
              ...current.entry,
              pluginOwnerId: binding.actor.sessions.readPolicy(current.storeKey)?.pluginOwnerId,
            }
          : current.entry,
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
      if (!memory) {
        assertRouting(context.getRuntimeConfig());
      }
      assertTarget(
        actorFacts
          ? actorFacts.readCurrent().target
          : resolveSessionSharingTarget({
              cfg: context.getRuntimeConfig(),
              sessionKey: request.sessionKey,
              agentId: requestedAgent.agentId,
            }),
      );
    };
    if (!memory) {
      assertCurrent();
    }
    const source: SessionSourceAssertion = Object.assign(assertCurrent, {
      async prepareSessionSource() {
        if (memory) {
          return { assertCurrent, checks: [] };
        }
        const authority = await prepareSessionSourceAuthority(
          composeSessionSourceAssertion([
            captureExternalSessionCommitGuard(options.sessionMutationCommitGuard),
            captureExternalSessionCommitGuard(authorization.authorization?.assertCurrent),
          ]),
        );
        if (authority.nativeSource) {
          return authority;
        }
        const assertHost = () => {
          authority.assertCurrent();
          assertRouting(context.getRuntimeConfig());
        };
        let read: Awaited<ReturnType<typeof prepareSessionSharingSource>> | undefined;
        try {
          read = await (binding
            ? withIncognitoSessionBinding(binding, () =>
                prepareSessionSharingSource(target, assertHost),
              )
            : prepareSessionSharingSource(target, assertHost));
          const held = read;
          const assertPrepared = () => {
            assertHost();
            held.assertCurrent();
            assertTarget(held.target);
          };
          assertPrepared();
          return {
            assertCurrent: assertPrepared,
            checks: [
              ...authority.checks,
              ...(held.actorSource
                ? []
                : [
                    {
                      predicate: {
                        source: held.source,
                        sessionKey: target.storeKey,
                        fields: ["sessionId", "lifecycleRevision", "pluginOwnerId"],
                        expected: held.target?.entry,
                      } satisfies SessionSourcePredicate,
                      refuse(
                        facts: import("../../config/sessions/session-source-authority.js").SessionSourcePredicateFacts,
                      ): never {
                        assertTarget(facts.entry ? { ...target, entry: facts.entry } : null);
                        throw new Error("Goal target source changed");
                      },
                    },
                  ]),
            ],
            release: () => releaseSessionSourceAuthorities([authority, held]),
          };
        } catch (error) {
          await releaseSessionSourceAuthorities(read ? [authority, read] : [authority], [error]);
          throw error;
        }
      },
    });
    const identity = {
      operationId: request.operationId,
      issuedAtMs: request.issuedAtMs,
      requestFingerprint: await fingerprintSessionGoalRequest({ method, ...request }),
      goalId: request.goalId,
    };
    if (!memory) {
      assertCurrent();
    }
    if (request.action === "resume") {
      const { handleSessionGoalResumeChat } = await import("./chat-send-handler.js");
      await handleSessionGoalResumeChat(
        {
          ...options,
          sessionMutationAuthorization: {
            assertCurrent: source,
            assertTargetCurrent: source,
          },
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
    const committed = await mutateSessionGoal({
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
      expectedSessionId: target.entry.sessionId,
      operation,
      assertCurrent: source,
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
