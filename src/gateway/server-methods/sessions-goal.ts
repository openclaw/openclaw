import {
  ErrorCodes,
  errorShape,
  validateSessionsGoalClearParams,
  validateSessionsGoalUpdateParams,
  type SessionsGoalClearParams,
  type SessionsGoalUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import {
  mutateSessionGoal,
  SessionGoalOperationError,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import {
  isGoalRecoveryDecisionCurrent,
  type GoalRecoveryDecisionAdmission,
} from "../../config/sessions/main-session-recovery.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
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
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { prepareSessionSharingSource } from "../session-sharing-source.js";
import {
  resolveSessionSharingTarget,
  resolveSessionMutationAuthorization,
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
  let releaseFacts: (() => void) | undefined;
  try {
    const authorization = options.sessionMutationAuthorization
      ? { authorization: options.sessionMutationAuthorization, error: null }
      : resolveSessionMutationAuthorization({
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
    const facts = await prepareSessionMutationFacts({
      cfg,
      sessionKey: request.sessionKey,
      agentId: requestedAgent.agentId,
      allowMissing: true,
    });
    releaseFacts = facts.release;
    const initial = facts.readCurrent(context.getRuntimeConfig());
    const target = initial.target;
    if (!target || (request.sessionId && target.entry.sessionId !== request.sessionId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Session changed or was removed; refresh its Goal."),
      );
      return;
    }
    const assertTarget = (current: ReturnType<typeof resolveSessionSharingTarget>) => {
      const prepared = facts.readCurrent(context.getRuntimeConfig());

      // Reset can keep the same session ID. Fence the lifecycle and resolved store as well.
      if (
        !current ||
        current.agentId !== target.agentId ||
        current.storePath !== target.storePath ||
        current.storeKey !== target.storeKey ||
        prepared.sourcePath !== initial.sourcePath ||
        prepared.sourceAgentId !== initial.sourceAgentId ||
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision
      ) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before its Goal update; retry."),
        );
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
      assertTarget(facts.readCurrent(context.getRuntimeConfig()).target);
    };
    // Chat admission retains the accepted target independently of this preparation lease.
    const assertAdmittedInputCurrent = () => {
      if (authorization.authorization?.assertAdmittedInputCurrent) {
        authorization.authorization.assertAdmittedInputCurrent();
      } else {
        options.sessionMutationCommitGuard?.();
        authorization.authorization?.assertCurrent();
      }
    };
    assertCurrent();
    const identity = {
      operationId: request.operationId,
      issuedAtMs: request.issuedAtMs,
      requestFingerprint: fingerprintSessionGoalRequest({ method, ...request }),
      goalId: request.goalId,
    };
    if (request.action === "resume") {
      let recoveryDecisionAdmission: GoalRecoveryDecisionAdmission | undefined;
      {
        const prepared = facts.readCurrent(context.getRuntimeConfig());
        const source = await withSessionEntryReadOnlyInWorker(
          {
            agentId: target.agentId,
            sessionKey: target.storeKey,
            storePath: prepared.sourcePath ?? target.storePath,
            projection: "list",
            readConsistency: "latest",
            hydrateSkillPromptRefs: false,
          },
          assertCurrent,
          async (loaded, owner) => {
            owner.assertCurrent();
            if (!loaded.ok) {
              throw loaded.error;
            }
            facts.readCurrent(context.getRuntimeConfig());
            return loaded.value;
          },
        );
        assertCurrent();
        const pause = source?.mainRestartRecovery?.pause;
        if (request.recoveryDecision && !pause) {
          const receipt = await lookupSessionGoalOperation({
            agentId: target.agentId,
            sessionKey: target.storeKey,
            storePath: target.storePath,
            expectedSessionId: target.entry.sessionId,
            operation: {
              ...identity,
              action: "resume",
              ...(request.note ? { note: request.note } : {}),
            },
          });
          if (receipt) {
            assertCurrent();
            respond(true, { ...receipt, replayed: true }, undefined, {
              cached: true,
              runId: receipt.runId,
            });
            return;
          }
          throw new SessionGoalOperationError(
            "recovery-decision-changed",
            "The recovery hold changed; review the current Goal.",
          );
        }
        const assertDecisionCaller = () => {
          assertAdmittedInputCurrent();
          if (
            !client?.connId ||
            client.invalidated ||
            client.connectionSignal?.aborted ||
            client.connect.role !== "operator" ||
            client.internal?.authenticatedOperator !== true ||
            client.internal.syntheticClient ||
            client.internal.agentRuntimeIdentity ||
            client.internal.agentToolCaller ||
            options.hasCurrentClientAuthority?.() === false ||
            context.isConnectionActive?.(client.connId) === false
          ) {
            throw new SessionGoalOperationError(
              "recovery-decision-caller",
              "Recovery requires a current authenticated explicit user decision.",
            );
          }
        };
        if (pause) {
          if (
            !source?.goal ||
            source.goal.id !== request.goalId ||
            request.sessionId !== source.sessionId
          ) {
            throw new SessionGoalOperationError(
              "goal-rebound",
              "The selected Goal changed; refresh it before continuing.",
            );
          }
          if (!request.recoveryDecision) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "An interrupted external action has no verified outcome. Review it before resuming this Goal.",
                {
                  details: {
                    code: "GOAL_RECOVERY_DECISION_REQUIRED",
                    reason: "goal-recovery-decision-required",
                    sessionId: source.sessionId,
                    goalId: source.goal.id,
                    recoveryDecision: {
                      cycleId: source.mainRestartRecovery!.cycleId,
                      revision: source.mainRestartRecovery!.revision,
                      pausedAtMs: pause.pausedAtMs,
                    },
                  },
                },
              ),
            );
            return;
          }
          recoveryDecisionAdmission = {
            reference: request.recoveryDecision,
            sessionId: source.sessionId,
            goalId: source.goal.id,
            assertCurrent: assertDecisionCaller,
          };
          if (!isGoalRecoveryDecisionCurrent(source, recoveryDecisionAdmission)) {
            throw new SessionGoalOperationError(
              "recovery-decision-changed",
              "The recovery decision changed; review it again.",
            );
          }
        }
      }
      if (recoveryDecisionAdmission) {
        const { handleSessionGoalRecovery } = await import("./session-goal-recovery.js");
        await handleSessionGoalRecovery(options, {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          operation: {
            ...identity,
            action: "resume",
            ...(request.note ? { note: request.note } : {}),
          },
          decision: recoveryDecisionAdmission,
        });
        return;
      }
      const { handleSessionGoalResumeChat } = await import("./chat-send-handler.js");
      await handleSessionGoalResumeChat(
        {
          ...options,
          sessionMutationAuthorization: {
            ...authorization.authorization,
            assertCurrent,
            assertTargetCurrent: assertCurrent,
            assertAdmittedInputCurrent,
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
    const assertRouting = captureSessionMutationRouting(
      cfg,
      () =>
        new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before its Goal update; retry."),
        ),
    );
    const source: SessionSourceAssertion = Object.assign(assertCurrent, {
      async prepareSessionSource() {
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
          read = await prepareSessionSharingSource(target, assertHost);
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
            ],
            release: () => releaseSessionSourceAuthorities([authority, held]),
          };
        } catch (error) {
          await releaseSessionSourceAuthorities(read ? [authority, read] : [authority], [error]);
          throw error;
        }
      },
    });
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
  } finally {
    releaseFacts?.();
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
