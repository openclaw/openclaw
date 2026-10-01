import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { shouldResumeParentSubagent } from "../../gateway/session-subagent-resume.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { bindRequesterYieldCronAuthority } from "../cron-creator-authority-context.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { isTerminalAgentWaitTimeout, waitForAgentRunReply } from "../run-wait.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { ToolInputError } from "../tool-input-error.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  formatSessionToolAccessDenial,
  recordSessionToolActionFact,
  resolveSessionToolAccess,
  resolveSessionToolContext,
} from "./sessions-helpers.js";
import {
  PlacedSessionsSendSchema,
  PLACED_SESSIONS_SEND_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import { dispatchSessionsSendFollowup } from "./sessions-send-followup.js";
import { buildAgentToAgentMessageContext } from "./sessions-send-helpers.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import { prepareSessionsSendRequester } from "./sessions-send-requester.js";
import { captureSessionsSendResumeCaller, resumeSessionsSendTask } from "./sessions-send-resume.js";
import { prepareSessionsSendTarget } from "./sessions-send-target.js";
import {
  normalizeSessionsSendArguments,
  parseSessionsSendOperation,
} from "./sessions-send-tool.arguments.js";
import {
  createConfiguredAgentMainSession,
  sessionsSendFailure as sendFailure,
  notifySessionsSendSession,
} from "./sessions-send-tool.delivery.js";
import { SessionsSendToolSchema, SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

const log = createSubsystemLogger("agents/sessions-send");

const NO_REPLY_MESSAGE = "No visible reply or pending announcement. Continue or retry if needed.";

export function createSessionsSendTool(opts?: SessionsSendToolOptions): AnyAgentTool {
  const requesterOrigin = normalizeDeliveryContext(opts?.requesterOrigin);
  const withRequesterAuthority = bindRequesterYieldCronAuthority(opts?.requesterTurnRunId);
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SEND_DESCRIPTION
      : describeSessionsSendTool(),
    parameters: opts?.workerPlacement ? PlacedSessionsSendSchema : SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args) => {
      const { params, message, mode, timeoutSeconds } = parseSessionsSendOperation(args);
      const promptedAt = Date.now();
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const resumeCaller =
        mode === undefined || mode === "resume" ? captureSessionsSendResumeCaller() : undefined;
      if (mode === "resume" && !resumeCaller) {
        return sendFailure("forbidden", "Task resume requires an admitted parent tool caller.");
      }
      const sessionContext = resolveSessionToolContext(opts);
      const { cfg, mainKey, effectiveRequesterKey, mainSessionKey, sessionVisibility, a2aPolicy } =
        sessionContext;
      let requesterAgentId: string;
      try {
        requesterAgentId = resolveSessionAgentId({
          config: cfg,
          sessionKey: effectiveRequesterKey,
          agentId: opts?.agentId,
        });
      } catch (err) {
        return sendFailure("forbidden", formatErrorMessage(err));
      }

      const target = await prepareSessionsSendTarget({
        toolContext: sessionContext,
        toolParams: params,
        requesterAgentId,
        callGateway: gatewayCall,
      });
      if (!target.ok) {
        return target.result;
      }
      const {
        visibleSession,
        resolvedKey,
        displayKey,
        unresolvedDisplayKey,
        targetAgentId,
        mayUseRequesterForLiteralSentinel,
      } = target;
      const {
        requesterSessionKey,
        requesterSession,
        requesterSessionEntry,
        requesterContinuationSession,
        requesterDeliveryGeneration,
        requesterIsSubagent,
        replyRequesterSessionKey,
      } = await prepareSessionsSendRequester({
        cfg,
        opts,
        effectiveRequesterKey,
        requesterAgentId,
        resolvedKey,
        mainKey,
      });
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = opts?.idempotencyKey ?? crypto.randomUUID();
      let runId: string = idempotencyKey;
      const sameSession = requesterSessionKey === resolvedKey && targetAgentId === requesterAgentId;
      // Fire-and-forget self-send remains a channel-delivery path. A synchronous
      // self-send would wait behind its own active session lane until timeout.
      if (timeoutSeconds !== 0 && sameSession) {
        return sendFailure(
          "error",
          "sessions_send cannot target the calling session; use your own reply instead",
          unresolvedDisplayKey,
          runId,
        );
      }
      if (resolveSessionThreadInfo(resolvedKey).threadId) {
        return sendFailure(
          "error",
          "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          unresolvedDisplayKey,
        );
      }
      const authorizationTargetKey = mayUseRequesterForLiteralSentinel
        ? effectiveRequesterKey
        : targetAgentId && !parseAgentSessionKey(resolvedKey)
          ? `agent:${targetAgentId}:${resolvedKey}`
          : resolvedKey;
      const access = await resolveSessionToolAccess({
        action: "send",
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        targetAgentId,
        targetSessionKey: resolvedKey,
        authorizationTargetSessionKey: authorizationTargetKey,
        requesterOwned: visibleSession.requesterOwned,
        visibility: sessionVisibility,
        a2aPolicy,
        callGateway: gatewayCall,
      });
      if (!access.allowed) {
        return sendFailure(
          access.status,
          formatSessionToolAccessDenial(access, {
            action: "send",
            targetSessionKey: unresolvedDisplayKey,
          }),
          unresolvedDisplayKey,
        );
      }
      const expectedSessionId = opts?.expectedTargetSessionId ?? access.expectedSessionId;
      if (mode === "notify" && expectedSessionId) {
        return sendFailure(
          "forbidden",
          "Notifications cannot outlive an exact-session access grant. Use steer or followup.",
          unresolvedDisplayKey,
          runId,
        );
      }

      return await runWithScopedSessionAccess({
        cfg,
        storePath: opts?.expectedTargetStorePath,
        agentId: targetAgentId,
        expectedSessionId,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        targetSessionKey: resolvedKey,
        run: async () => {
          if (visibleSession.missing) {
            if (mode === "steer" || mode === "notify" || mode === "resume") {
              return sendFailure(
                "error",
                "Cannot notify, steer, or resume a missing session. Use mode=followup to start a new turn.",
                displayKey,
                runId,
              );
            }
          }

          const requesterChannel = opts?.agentChannel;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          let targetSession = await resolveGatewaySessionStoreTargetInWorker({
            cfg,
            key: resolvedKey,
            agentId: targetAgentId,
          });
          let targetSessionEntry = targetSession.store[targetSession.canonicalKey];
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: replyRequesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
            ...(requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
          };
          const dispatchMessage = annotateInterSessionPromptText(message, inputProvenance);
          let communication: Awaited<ReturnType<typeof prepareSessionsSendCommunication>>;
          try {
            communication = await prepareSessionsSendCommunication({
              config: cfg,
              source: {
                agentId: requesterSession.agentId,
                sessionKey: requesterSession.canonicalKey,
                storePath: requesterSession.readSource?.path ?? requesterSession.storePath,
                entry: requesterSessionEntry,
              },
              target: {
                agentId: targetSession.agentId,
                sessionKey: targetSession.canonicalKey,
                storePath: targetSession.readSource?.path ?? targetSession.storePath,
                entry: targetSessionEntry,
              },
              message,
              dispatchMessage,
              inputProvenance,
              access: {
                sandboxed: opts?.sandboxed,
                requesterOwned: visibleSession.requesterOwned,
                authorizationTargetSessionKey: authorizationTargetKey,
                expectedSessionId,
              },
              ensureTarget: visibleSession.missing
                ? async (assertCurrent) => {
                    const created = await createConfiguredAgentMainSession({
                      callGateway: gatewayCall,
                      agentId: targetAgentId,
                      sessionKey: resolvedKey,
                      requesterSessionKey,
                      useTrustedInProcessCreation: opts?.callGateway === undefined,
                      assertCommunicationCurrent: assertCurrent,
                    });
                    if (!created.ok) {
                      throw new Error(created.error);
                    }
                    targetSession = await resolveGatewaySessionStoreTargetInWorker({
                      cfg,
                      key: resolvedKey,
                      agentId: targetAgentId,
                    });
                    targetSessionEntry = targetSession.store[targetSession.canonicalKey];
                    return {
                      agentId: targetSession.agentId,
                      sessionKey: targetSession.canonicalKey,
                      storePath: targetSession.readSource?.path ?? targetSession.storePath,
                      entry: targetSessionEntry,
                    };
                  }
                : undefined,
              signal: opts?.signal,
              assertSourceCurrent: opts?.assertSourceCurrent,
              callGateway: gatewayCall,
            });
          } catch (error) {
            return sendFailure(
              "forbidden",
              unresolvedDisplayKey === undefined
                ? "Communication with the session selected by label was not authorized. Check its communication settings or use an authorized exact session key."
                : formatErrorMessage(error),
              unresolvedDisplayKey,
              runId,
            );
          }
          try {
            const targetAcpMeta = readAcpSessionMetaForEntry({
              sessionKey: targetSession.canonicalKey,
              agentId: targetSession.agentId,
              cfg,
              entry: targetSessionEntry,
            });
            const targetIsSubagent = isSubagentSessionFromEntry(
              targetSession.canonicalKey,
              targetSessionEntry,
              targetAcpMeta,
            );
            const agentMessageContext =
              requesterIsSubagent || targetIsSubagent
                ? undefined
                : buildAgentToAgentMessageContext({
                    requesterSessionKey: replyRequesterSessionKey,
                    requesterChannel,
                  });
            if (mode === "notify") {
              return await notifySessionsSendSession({
                message,
                assertCommunicationCurrent: communication.assertCurrent,
                inputProvenance,
                sessionKey: resolvedKey,
                targetAgentId,
                idempotencyKey,
                runId,
                displayKey,
              });
            }
            const sendParams = {
              message: dispatchMessage,
              agentId: targetAgentId,
              sessionKey: resolvedKey,
              idempotencyKey,
              deliver: false,
              sourceReplyDeliveryMode: "message_tool_only" as const,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: resolveNestedAgentLaneForSession(resolvedKey),
              extraSystemPrompt: agentMessageContext,
              inputProvenance,
            };
            if (
              mode === "resume" ||
              (mode === undefined &&
                resumeCaller &&
                !targetAcpMeta &&
                shouldResumeParentSubagent({
                  cfg,
                  caller: resumeCaller,
                  childSessionKey: resolvedKey,
                }))
            ) {
              if (!resumeCaller) {
                throw new ToolInputError("Task resume requires an admitted parent tool caller.");
              }
              return await resumeSessionsSendTask({
                cfg,
                caller: resumeCaller,
                targetAgentId,
                sessionKey: resolvedKey,
                displayKey,
                runId,
                expectedSessionId,
                sendParams,
                callGateway: communication.callGateway,
              });
            }
            // ACP background tasks already report to their parent through task completion.
            const targetSessionEntryWithAcp = targetSessionEntry
              ? { ...targetSessionEntry, acp: targetAcpMeta }
              : targetSessionEntry;
            const skipTaskReplyFlow = isRequesterParentOfBackgroundAcpSession(
              targetSessionEntryWithAcp,
              effectiveRequesterKey,
            );
            // Completion belongs to the operation, never to its incarnation access fence.
            const completionPlan =
              opts?.completionOwner === "caller" || access.basis === "scoped-grant"
                ? "caller"
                : requesterIsSubagent || skipTaskReplyFlow || communication.ownedTask
                  ? "task"
                  : targetIsSubagent && !isIsolatedCronRequester
                    ? "one-way"
                    : "peer";
            const replyMode =
              completionPlan === "peer" || completionPlan === "one-way"
                ? completionPlan
                : undefined;

            const ownChild = targetSessionEntry?.spawnedBy === effectiveRequesterKey;
            const startParams: Parameters<typeof dispatchSessionsSendFollowup>[0] = {
              cfg,
              callGateway: communication.callGateway,
              prepareFallback: async (sessionKey) => {
                const fallback = await resolveGatewaySessionStoreTargetInWorker({
                  cfg,
                  key: sessionKey,
                  agentId: targetAgentId,
                });
                return prepareSessionsSendCommunication({
                  config: cfg,
                  source: {
                    agentId: requesterSession.agentId,
                    sessionKey: requesterSession.canonicalKey,
                    storePath: requesterSession.readSource?.path ?? requesterSession.storePath,
                    entry: requesterSessionEntry,
                  },
                  target: {
                    agentId: fallback.agentId,
                    sessionKey: fallback.canonicalKey,
                    storePath: fallback.readSource?.path ?? fallback.storePath,
                    entry: fallback.store[fallback.canonicalKey],
                  },
                  message,
                  dispatchMessage,
                  inputProvenance,
                  access: { sandboxed: communication.sourceSandboxed },
                  assertSourceCurrent: opts?.assertSourceCurrent,
                  signal: opts?.signal,
                  callGateway: gatewayCall,
                });
              },
              assertCommunicationCurrent: communication.assertCurrent,
              retainCommunicationInput: communication.retainInput,
              runId,
              mode,
              sendParams,
              sourceOrigin: sameSession ? requesterOrigin : undefined,
              sessionKey: mode || ownChild ? resolvedKey : displayKey,
              sessionStoreTarget: targetSession,
              deliveryTimeoutMs: announceTimeoutMs,
              allowActiveRunQueueDelivery: timeoutSeconds === 0,
              expectedSessionId,
            };
            const replyContext: Parameters<typeof dispatchSessionsSendFollowup>[1] = {
              callGateway: gatewayCall,
              targetSessionKey: resolvedKey,
              targetAgentId,
              displayKey,
              message,
              announceTimeoutMs,
              maxPingPongTurns: isIsolatedCronRequester ? 0 : 5,
              replyMode,
              requesterSessionKey: replyRequesterSessionKey,
              requesterSandboxed: communication.sourceSandboxed,
              requesterAgentId,
              requesterSession: requesterContinuationSession,
              requesterDeliveryGeneration,
              requesterOrigin,
              requesterChannel,
            };
            const { start, completion, registryCompletion, watchField } =
              await dispatchSessionsSendFollowup(startParams, replyContext, {
                ownChild,
                nativeChild: !targetAcpMeta,
                requesterSessionKey: effectiveRequesterKey,
                requesterAgentId,
                requesterTurnRunId: opts?.requesterTurnRunId,
                withRequesterAuthority,
                watch: params.watch === true,
              });
            if (!start.ok) {
              return start.result;
            }
            const acceptedTargetSessionKey = start.a2aSessionKey ?? resolvedKey;
            // Steering keeps its active owner; an inline child reply is already delivered.
            const delayedDelivery = {
              status:
                registryCompletion || (replyMode && start.targetDisposition === "queued")
                  ? "pending"
                  : "skipped",
              mode: "announce",
            } as const;
            const delivery =
              timeoutSeconds > 0 && targetIsSubagent
                ? ({ status: "skipped", mode: "announce" } as const)
                : delayedDelivery;
            recordSessionToolActionFact({
              operation: "send",
              fact: "committed",
              targetAgentId,
              targetSessionKey: acceptedTargetSessionKey,
            });
            try {
              const acceptedTarget = start.a2aSessionKey
                ? await resolveGatewaySessionStoreTargetInWorker({
                    cfg,
                    key: acceptedTargetSessionKey,
                    agentId: targetAgentId,
                  })
                : targetSession;
              if (start.a2aSessionKey && !acceptedTarget.store[acceptedTarget.canonicalKey]) {
                throw new Error("Accepted Cron parent has no stored session entry.");
              }
              recordSessionParticipantBestEffort({
                identity: { type: "agent", id: requesterAgentId },
                promptedAt,
                agentId: acceptedTarget.agentId,
                sessionKey: acceptedTarget.canonicalKey,
                storePath: acceptedTarget.storePath,
                onError: (error) => log.warn("failed to record session participant", { error }),
              });
            } catch (error) {
              log.warn("failed to record session participant", { error });
            }
            runId = start.runId;
            const accepted = (acceptedDelivery: typeof delayedDelivery) =>
              jsonResult({
                runId,
                status: "accepted",
                sessionKey: displayKey,
                targetDisposition: start.targetDisposition,
                delivery: acceptedDelivery,
                ...watchField,
              });
            const startReplyFlow = ({
              reply,
              notifyRequesterOnWaitFailure = false,
            }: {
              reply?: Awaited<ReturnType<typeof waitForAgentRunReply>>;
              notifyRequesterOnWaitFailure?: boolean;
            }) =>
              startSessionsSendReplyFlow({
                ...replyContext,
                runId,
                completion,
                reply,
                skip:
                  registryCompletion || (reply ? delivery : delayedDelivery).status === "skipped",
                targetSessionKey: acceptedTargetSessionKey,
                displayKey: start.a2aSessionKey ?? displayKey,
                notifyRequesterOnWaitFailure:
                  notifyRequesterOnWaitFailure && !isIsolatedCronRequester,
              });
            if (timeoutSeconds === 0) {
              startReplyFlow({ notifyRequesterOnWaitFailure: true });
              return accepted(delivery);
            }

            const result = completion
              ? await completion.take(timeoutMs)
              : await waitForAgentRunReply({ runId, timeoutMs, callGateway: gatewayCall });
            if (!result) {
              startReplyFlow({ notifyRequesterOnWaitFailure: true });
              return accepted(delayedDelivery);
            }
            completion?.close();

            if (result.status === "timeout") {
              if (result.pendingError === true && result.error?.trim()) {
                startReplyFlow({ notifyRequesterOnWaitFailure: targetIsSubagent });
                return jsonResult({
                  runId,
                  status: "timeout",
                  error: result.error,
                  sentBeforeError: true,
                  sessionKey: displayKey,
                  delivery: delayedDelivery,
                  ...watchField,
                });
              }
              if (!isTerminalAgentWaitTimeout(result)) {
                startReplyFlow({ notifyRequesterOnWaitFailure: true });
                return accepted(delayedDelivery);
              }
            }
            if (result.status === "timeout" || result.status === "error") {
              return jsonResult({
                runId,
                status: result.status,
                error:
                  result.error ??
                  (result.status === "timeout" ? "agent run timed out" : "agent error"),
                sentBeforeError: true,
                sessionKey: displayKey,
                ...watchField,
              });
            }
            const reply = result.replyText;
            const response = reply
              ? { status: "ok" as const, delivery, reply }
              : {
                  status: "no_reply" as const,
                  message: result.sourceReplyDelivered
                    ? "The target delivered its final reply directly to its source conversation. Do not resend."
                    : NO_REPLY_MESSAGE,
                };
            if (reply) {
              startReplyFlow({ reply: result });
            }
            return jsonResult({ runId, sessionKey: displayKey, ...response, ...watchField });
          } finally {
            communication.close();
          }
        },
      });
    }),
  };
}
