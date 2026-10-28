import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../agents/cron-creator-authority-context.js";
import { buildMainSessionRecoverySettlementPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { isGoalContinuationCurrent } from "../auto-reply/reply/goal-continuation.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  getRpcSourceIdentity,
  isRpcSourceRegistered,
} from "../sessions/session-controller.rpc-sources.js";
import { resolveAgentRestartRecoveryContext } from "./agent-turn/agent-restart-recovery-context.js";
import { createAgentTurnStartOwner } from "./agent-turn/internal-facade.js";
import { revokeCronCreatorAuthorityRunScope } from "./cron-creator-authority-grant.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
} from "./message-action-turn-capability.js";
import {
  bindGatewayOperatorContinuationAuthority,
  captureGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import type {
  OperatorRecoveryTarget,
  RestoredGatewayOperatorAuthority,
} from "./operator-run-recovery.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "./server-methods/cron-creator-authority-admission.js";
import { launchSessionRecoveryContinuation } from "./server-methods/session-recovery-continuation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

export type RecoveryGoalContinuation = {
  dispatch: <T>(waitForAgent: GatewayRecoveryRuntime["waitForAgent"]) => Promise<T>;
  release: () => void;
};

/** The recovered Goal turn itself enters the ordinary reply/Goal owner. */
export async function prepareRecoveryGoalContinuation(params: {
  target: OperatorRecoveryTarget;
  request: AgentRunRequest;
  options: GatewayInstanceAgentDispatchOptions;
  operator: RestoredGatewayOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  parentSource?: SessionSourceAssertion;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  assertGatewayCurrent: () => void;
}): Promise<RecoveryGoalContinuation | undefined> {
  params.assertCurrent();
  const entry = await readSessionEntryReadOnlyInWorker(params.target, params.assertCurrent);
  params.assertCurrent();
  if (
    !entry?.goal ||
    entry.goal.status !== "active" ||
    (entry.agentHarnessId !== undefined && entry.agentHarnessId !== "openclaw")
  ) {
    return undefined;
  }
  const recoveryContext = resolveAgentRestartRecoveryContext({
    isRestartRecoveryResumeRun: true,
    canUseInternalRuntimeHandoff: true,
    expectedExistingSessionId: params.target.sessionId,
    resolvedSessionId: entry.sessionId,
    resolvedSessionKey: params.target.sessionKey,
    runId: params.target.recoveryRunId,
    sessionEntry: entry,
  });
  const channelSource = recoveryContext?.channel;
  const generation = getAgentEventLifecycleGeneration();
  if (
    !params.options.controllerInput ||
    entry.restartRecoveryDeliveryRunId !== params.target.recoveryRunId ||
    entry.restartRecoveryDeliverySourceRunId !== params.target.sourceRunId ||
    entry.mainRestartRecovery?.reservation?.runId !== params.target.recoveryRunId
  ) {
    throw new Error("Goal recovery no longer owns its reserved input.");
  }
  const identity = {
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    goalId: entry.goal.id,
  };
  const sourceClient = createSyntheticPluginRuntimeClient({
    operatorRunAuthority: params.operator.authority,
    scopes: [...params.operator.authority.scopes],
  });
  const captured = await captureGatewayOperatorRunAuthority({
    client: sourceClient,
    context: params.context,
    independentContinuation: true,
  });
  if (!captured) {
    throw new Error("Goal recovery has no retained operator policy.");
  }
  let releaseParent: (() => void) | undefined;
  try {
    params.assertCurrent();
    releaseParent = params.parentSource?.retain?.();
    const policy = captured.authority;
    // Only this same-session reply receives the parent's committed compaction fact.
    const replyPolicy = Object.assign(composeSessionSourceAssertion([policy.assertCurrent]), {
      onSessionCompactionCommitted:
        params.operator.authority.assertCurrent.onSessionCompactionCommitted,
    });
    const assertCurrent = composeSessionSourceAssertion(
      [replyPolicy, params.parentSource],
      (assertSources) => {
        params.assertGatewayCurrent();
        if (getAgentEventLifecycleGeneration() !== generation) {
          throw new Error("Goal recovery Gateway lifecycle changed.");
        }
        assertSources();
      },
    );
    // Preserve only the existing recovery-specific entitlement, not fresh-user admission.
    const cronAdmission = resolveGatewayCronCreatorAuthorityAdmission({
      runId: params.target.recoveryRunId,
      resolvedSessionKey: params.target.sessionKey,
      sessionId: entry.sessionId,
      spawnedBy: entry.spawnedBy,
      client: sourceClient,
      request: params.request,
      inputProvenance: params.request.inputProvenance,
      hasRestoredCronContinuation: entry.cronRunContinuation !== undefined,
      isOneShotModelRun: false,
      isRestartRecoveryResumeRun: true,
    });
    const cronCapability = cronAdmission
      ? createCronCreatorAuthorityCapability(
          cronAdmission.runId,
          cronAdmission.callerOrigin,
          cronAdmission.managementEntitlement,
          () => {
            assertCurrent();
            return true;
          },
          undefined,
          cronAdmission.requesterOwner,
          cronAdmission.callerScopedCreation,
        )
      : undefined;
    const authority = createAdmittedRunOperatorAuthority({
      ...policy,
      assertCurrent,
      retain: () => {
        assertCurrent();
        const releasePolicy = policy.retain?.();
        const releaseSource = params.parentSource?.retain?.();
        return () => {
          releaseSource?.();
          releasePolicy?.();
        };
      },
      get modelPolicy() {
        return policy.modelPolicy;
      },
    });
    // Children retain policy, not this reply's parent-specific compaction notification.
    bindGatewayOperatorContinuationAuthority(authority, policy);
    const client = createSyntheticPluginRuntimeClient({
      authenticatedUserProfile: params.operator.authenticatedUserProfile,
      operatorRoleActor: { kind: "operator", profileId: authority.profileId },
      operatorRunAuthority: authority,
      scopes: [...authority.scopes],
      ...(params.requesterOrigin
        ? {
            agentToolCaller: {
              agentId: params.target.agentId,
              sessionKey: params.target.sessionKey,
              requesterOrigin: params.requesterOrigin,
              assertCurrent,
            },
          }
        : {}),
    });
    return {
      release: () => {
        if (cronCapability) {
          revokeCronCreatorAuthorityRunScope(cronCapability);
        }
        releaseParent?.();
        captured.release();
      },
      async dispatch<T>(waitForAgent: GatewayRecoveryRuntime["waitForAgent"]): Promise<T> {
        const dispatch = () =>
          withPluginRuntimeGatewayContextResolver(
            params.context.resolveGatewayContext,
            async () => {
              let settlement: Promise<unknown> | undefined;
              const outcome = await launchSessionRecoveryContinuation({
                ...params.target,
                context: params.context,
                client,
                commitGuard: params.assertCurrent,
                assertAdmittedSourceCurrent: assertCurrent,
                idempotencyKey: params.target.recoveryRunId,
                req: { type: "req", id: params.target.recoveryRunId, method: "chat.send" },
                resume: {
                  sessionId: identity.sessionId,
                  lifecycleRevision: identity.lifecycleRevision,
                  expectedState: {
                    ...buildRestartRecoveryExpectedState(entry),
                    expectedWriterRunId: entry.activeWriterRunId,
                    pendingFinalDelivery: entry.pendingFinalDelivery ?? null,
                  },
                  // The ordinary input and retirement of the interrupted owner commit together.
                  lifecycle: buildMainSessionRecoverySettlementPatch({
                    entry,
                    recordTerminalSource: true,
                  }),
                  forceRestartSafeTools: params.request.forceRestartSafeTools === true,
                  ...(params.request.forceCodeModeTools ? { forceCodeModeTools: true } : {}),
                },
                preparedInput: {
                  message: params.request.message,
                  provenance: params.request.inputProvenance,
                  deliver: params.request.deliver === true,
                  ...(params.request.channel && params.request.to
                    ? {
                        deliveryContext: {
                          channel: params.request.channel,
                          to: params.request.to,
                          accountId: params.request.accountId,
                          threadId: params.request.threadId,
                        },
                      }
                    : {}),
                  options: {
                    controllerInput: params.options.controllerInput,
                    onInputCommitted: () => {
                      params.options.onRecoveryInputTransferred?.();
                      params.operator.onReplyInputCommitted?.();
                    },
                    continuationPolicy: {
                      sourceReplyDeliveryMode: params.request.sourceReplyDeliveryMode,
                      cronCreatorAuthorityCapability: cronCapability,
                      ...(channelSource && isTrustedMessageActionTurnIngress(channelSource.channel)
                        ? {
                            prepareMessageActionTurnCapability: (current) => {
                              assertCurrent();
                              if (
                                current.agentId !== params.target.agentId ||
                                current.sessionKey !== params.target.sessionKey
                              ) {
                                throw new Error("Goal recovery message source changed.");
                              }
                              const channel = channelSource;
                              return mintMessageActionTurnCapability({
                                ...current,
                                sessionKey: current.runtimePolicySessionKey ?? current.sessionKey,
                                sourceReplySessionKey: current.sessionKey,
                                requesterAccountId:
                                  channel.requesterAccountId ?? params.request.accountId,
                                requesterSenderId: channel.requesterSenderId,
                                toolContext: {
                                  currentChannelProvider: channel.channel,
                                  currentChannelId: channel.currentChannelId,
                                  currentThreadTs: channel.currentThreadTs,
                                  currentSourceTurnId: channel.sourceTurnId,
                                  sameChannelThreadRequired: channel.sameChannelThreadRequired,
                                },
                                expiresWithRun: true,
                              });
                            },
                          }
                        : {}),
                    },
                    onExecutionStarted: params.options.onExecutionStarted,
                    onSourceAdmitted: (source) => {
                      assertCurrent();
                      if (
                        source.input !== params.options.controllerInput ||
                        source.input.protocolRunId !== params.target.recoveryRunId ||
                        getRpcSourceIdentity(source).sessionId !== identity.sessionId
                      ) {
                        throw new Error("Goal recovery lost its reserved source.");
                      }
                      settlement = source.input.settlement.promise;
                      params.options.onStartOwner?.(
                        createAgentTurnStartOwner({
                          context: params.context,
                          runId: params.target.recoveryRunId,
                          entry: source,
                          isCurrent: () => {
                            try {
                              assertCurrent();
                              return (
                                isRpcSourceRegistered(source) &&
                                getRpcSourceIdentity(source).sessionKey === params.target.sessionKey
                              );
                            } catch {
                              return false;
                            }
                          },
                        }),
                      );
                    },
                    beforeDispatch: async ({ runId, assertWorkAdmissionCurrent }) => {
                      await params.options.prepareDispatchCurrent?.();
                      params.options.signal?.throwIfAborted();
                      assertCurrent();
                      assertWorkAdmissionCurrent();
                      const current = await readSessionEntryReadOnlyInWorker(
                        params.target,
                        assertCurrent,
                      );
                      assertCurrent();
                      assertWorkAdmissionCurrent();
                      if (
                        !isGoalContinuationCurrent(identity, current) ||
                        runId !== params.target.recoveryRunId
                      ) {
                        throw new Error("Goal recovery objective changed before execution.");
                      }
                    },
                  },
                },
              });
              if (outcome.status === "rejected") {
                throw new Error(outcome.error.message);
              }
              params.options.onAccepted?.({ runId: outcome.runId, status: "accepted" });
              if (!settlement) {
                throw new Error("Goal recovery was accepted without reserved source custody.");
              }
              // The ordinary source includes reply/media settlement; a lifecycle end alone is insufficient.
              await settlement;
              return waitForAgent<T>({ runId: outcome.runId, timeoutMs: 0 });
            },
            { inheritRequestScope: false },
          );
        return cronCapability
          ? runWithCronCreatorAuthorityCapability(
              cronCapability,
              dispatch,
              params.options.controllerInput?.abortSignal,
            )
          : dispatch();
      },
    };
  } catch (error) {
    releaseParent?.();
    captured.release();
    throw error;
  }
}
