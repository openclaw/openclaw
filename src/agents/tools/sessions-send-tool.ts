import crypto from "node:crypto";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { resolveSessionStoreKey } from "../../gateway/session-store-key.js";
import { shouldResumeParentSubagent } from "../../gateway/session-subagent-resume.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  normalizeAgentIdStrict,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { bindRequesterYieldCronAuthority } from "../cron-creator-authority-context.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { ToolInputError } from "../tool-input-error.js";
import type { AnyAgentTool } from "./common.js";
import { readToolStringParam } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  isExpectedSessionLookupMiss,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import {
  PlacedSessionsSendSchema,
  PLACED_SESSIONS_SEND_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import { dispatchSessionsSendFollowup } from "./sessions-send-followup.js";
import { sendFailure } from "./sessions-send-helpers.js";
import {
  finishSessionsSendReply,
  prepareSessionsSendReplyContext,
} from "./sessions-send-reply-flow.js";
import { captureSessionsSendResumeCaller, resumeSessionsSendTask } from "./sessions-send-resume.js";
import {
  createSessionsSendSessionReaders,
  withSessionsSendRequesterSource,
} from "./sessions-send-session-source.js";
import {
  callSessionsSendGateway,
  createConfiguredAgentMainSession,
  isConfiguredAgentMainSessionKey,
  notifySessionsSendSession,
  resolveConfiguredAgentMainSessionKey,
} from "./sessions-send-tool.delivery.js";
import * as input from "./sessions-send-tool.input.js";
import { SessionsSendToolSchema, SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

export function createSessionsSendTool(opts?: SessionsSendToolOptions): AnyAgentTool {
  const requesterOrigin = normalizeDeliveryContext(opts?.requesterOrigin);
  const withRequesterAuthority = bindRequesterYieldCronAuthority(opts?.requesterTurnRunId);
  const tool: AnyAgentTool = {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SEND_DESCRIPTION
      : describeSessionsSendTool(),
    parameters: opts?.workerPlacement ? PlacedSessionsSendSchema : SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args) => {
      const params = isRecord(args) ? args : {};
      const promptedAt = Date.now();
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const sendGatewayCall = opts?.callGateway ?? callSessionsSendGateway;
      const message = input.readSessionsSendMessage(params);
      const mode = input.readSessionsSendMode(params);
      const resumeCaller =
        mode === undefined || mode === "resume" ? captureSessionsSendResumeCaller() : undefined;
      if (mode === "resume" && !resumeCaller) {
        return sendFailure("forbidden", "Task resume requires an admitted parent tool caller.");
      }
      const timeoutSeconds = input.readSessionsSendTimeout(params, mode);
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const readConfig = createRuntimeConfigReader(cfg);
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
      const { readTarget: readSession, readRequester } = createSessionsSendSessionReaders(cfg);

      const sessionKeyParam = readToolStringParam(params, "sessionKey");
      const labelParam = readToolStringParam(params, "label");
      const labelAgentIdInput = readToolStringParam(params, "agentId");
      const normalizedLabelAgentId =
        labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
      if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
        return sendFailure(
          "error",
          `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
        );
      }
      const explicitTargetAgentId = normalizedLabelAgentId?.value;

      let sessionKey = sessionKeyParam;
      let resolvedTargetAgentId: string | undefined;
      let resolvedLabelKey: string | undefined;
      if (!sessionKey && !labelParam && explicitTargetAgentId) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: explicitTargetAgentId,
          mainKey,
        });
        if (!agentMainKey) {
          return sendFailure(
            "error",
            `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
          );
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requestedAgentId = explicitTargetAgentId;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return sendFailure(
            "forbidden",
            "Sandboxed sessions_send label lookup is limited to this agent",
          );
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return sendFailure(
              "forbidden",
              "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            );
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return sendFailure(
              "forbidden",
              "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            );
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ agentId?: string; key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
          resolvedTargetAgentId = normalizeOptionalString(resolved?.agentId);
        } catch (err) {
          if (!isExpectedSessionLookupMiss(err)) {
            const failure = sessionOwnershipLookupFailure(err);
            logSessionOwnershipLookupFailure({
              requesterSessionKey: effectiveRequesterKey,
              failure,
            });
            return sendFailure(
              restrictToSpawned ? "forbidden" : "error",
              restrictToSpawned
                ? lookupFailedDenialMessage("send", failure.kind)
                : lookupFailedOperationMessage("send", failure.kind),
            );
          }
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return sendFailure(
              "forbidden",
              "Session not visible from this sandboxed agent session.",
            );
          }
          return sendFailure("error", `No session found with label: ${labelParam}`);
        }
        sessionKey = resolvedKey;
        resolvedLabelKey = resolvedKey;
      }

      if (!sessionKey) {
        return sendFailure("error", "Either sessionKey or label is required");
      }
      const allowMissingKey = isConfiguredAgentMainSessionKey({
        cfg,
        sessionKey,
        mainKey,
      });
      const resolvedSession = resolvedLabelKey
        ? {
            ok: true as const,
            ...(resolvedTargetAgentId ? { agentId: resolvedTargetAgentId } : {}),
            key: resolvedLabelKey,
            displayKey: resolveDisplaySessionKey({ key: resolvedLabelKey, alias, mainKey }),
            resolvedViaSessionId: false,
            requesterOwned: restrictToSpawned,
          }
        : await resolveSessionReference({
            action: "send",
            sessionKey,
            keyAgentId: requesterAgentId,
            alias,
            mainKey,
            requesterInternalKey: effectiveRequesterKey,
            restrictToSpawned,
            callGateway: gatewayCall,
          });
      if (!resolvedSession.ok) {
        return sendFailure(resolvedSession.status, resolvedSession.error);
      }
      if (
        resolvedSession.resolvedViaSessionId &&
        !resolvedSession.agentId &&
        classifySessionKeyShape(resolvedSession.key) === "legacy_or_alias"
      ) {
        return sendFailure(
          "forbidden",
          "Session ownership could not be verified. Upgrade the gateway or use an agent-prefixed session key.",
          sessionKey,
        );
      }
      const resolutionAccess = createSessionVisibilityRowChecker({
        action: "send",
        defaultAgentId: resolveSessionToolTargetAgentId({
          cfg,
          targetSessionKey: resolvedSession.key,
          resolvedAgentId: resolvedSession.agentId,
          requesterAgentId,
        }),
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility: sessionVisibility,
        a2aPolicy,
      }).check({ key: resolvedSession.key });
      const visibleSession = await resolveVisibleSessionReference({
        action: "send",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
        allowMissingKey,
        concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
        callGateway: gatewayCall,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return sendFailure(visibleSession.status, visibleSession.error, unresolvedDisplayKey);
      }
      let resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const resolvedKeyAgentId = parseAgentSessionKey(resolvedKey)?.agentId;
      const isLiteralLegacyKeyInput =
        !labelParam && sessionKeyParam !== undefined && !resolvedSession.resolvedViaSessionId;
      const isLiteralUnscopedTarget =
        isLiteralLegacyKeyInput && classifySessionKeyShape(resolvedKey) === "legacy_or_alias";
      const persistedTargetOwner = isLiteralUnscopedTarget
        ? resolvePersistedSessionStoreOwnerForKey(cfg, resolvedKey)
        : { kind: "none" as const };
      const compatibilityTargetAgentId =
        isLiteralUnscopedTarget && persistedTargetOwner.kind === "none"
          ? tryResolveLegacyCompatibilityAgentId(cfg)
          : undefined;
      const isLiteralUnscopedMainTarget =
        isLiteralUnscopedTarget &&
        (isUnscopedSessionKeySentinel(sessionKeyParam.trim()) ||
          sessionKeyParam.trim().toLowerCase() === mainKey);
      if (persistedTargetOwner.kind === "retired") {
        return sendFailure(
          "forbidden",
          "Session ownership could not be verified because its fixed-store owner retired.",
          unresolvedDisplayKey,
        );
      }
      const resolvedTargetOwner =
        visibleSession.agentId ??
        resolvedTargetAgentId ??
        (labelParam ? explicitTargetAgentId : undefined);
      if (
        persistedTargetOwner.kind === "configured" &&
        resolvedTargetOwner &&
        normalizeAgentId(resolvedTargetOwner) !== persistedTargetOwner.agentId
      ) {
        return sendFailure(
          "forbidden",
          `Session belongs to agent "${persistedTargetOwner.agentId}", not "${normalizeAgentId(resolvedTargetOwner)}".`,
          unresolvedDisplayKey,
        );
      }
      const targetAgentId =
        (persistedTargetOwner.kind === "configured" ? persistedTargetOwner.agentId : undefined) ??
        resolvedTargetOwner ??
        resolvedKeyAgentId ??
        (isLiteralUnscopedMainTarget ? requesterAgentId : undefined) ??
        compatibilityTargetAgentId;
      if (!targetAgentId) {
        return sendFailure(
          "forbidden",
          "Session ownership could not be verified. Upgrade the gateway or use an agent-prefixed session key.",
          unresolvedDisplayKey,
        );
      }
      resolvedKey = resolveSessionStoreKey({
        cfg,
        sessionKey: resolvedKey,
        storeAgentId: targetAgentId,
      });
      const mayUseRequesterForLiteralSentinel =
        isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId;
      const requesterSession = await readRequester(effectiveRequesterKey, requesterAgentId);
      if (!requesterSession) {
        return sendFailure("forbidden", "The requesting session is no longer available.");
      }
      const requesterSessionKey = opts?.agentSessionKey ? requesterSession.canonicalKey : undefined;
      const requesterSessionEntry = requesterSession.store[requesterSession.canonicalKey];
      if (opts?.agentSessionId && requesterSessionEntry?.sessionId !== opts.agentSessionId) {
        return sendFailure("forbidden", "The sending session incarnation changed.");
      }
      const requesterIsSubagent = isSubagentSessionFromEntry(
        requesterSession.canonicalKey,
        requesterSessionEntry,
        readAcpSessionMetaForEntry({
          sessionKey: requesterSession.canonicalKey,
          agentId: requesterSession.agentId,
          cfg,
          entry: requesterSessionEntry,
        }),
      );
      const timeoutMs = finiteSecondsToTimerSafeMilliseconds(timeoutSeconds) ?? 0;
      const replyTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = opts?.idempotencyKey ?? crypto.randomUUID();
      const runId: string = idempotencyKey;
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
        watch: params.watch === true,
        readConfig,
        sandboxed: opts?.sandboxed,
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
          displayKey,
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
          if (
            visibleSession.missing &&
            (mode === "steer" || mode === "notify" || mode === "resume")
          ) {
            return sendFailure(
              "error",
              "Cannot notify, steer, or resume a missing session. Use mode=followup to start a new turn.",
              displayKey,
              runId,
            );
          }
          const requesterChannel = opts?.agentChannel;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          let targetSession = await readSession(resolvedKey, targetAgentId);
          let targetSessionEntry = targetSession.store[targetSession.canonicalKey];
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
            ...(requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
          };
          let dispatchMessage = annotateInterSessionPromptText(message, inputProvenance);
          const initialAcpMeta = readAcpSessionMetaForEntry({
            sessionKey: targetSession.canonicalKey,
            agentId: targetSession.agentId,
            cfg,
            entry: targetSessionEntry,
          });
          if (
            !initialAcpMeta &&
            targetSessionEntry?.status === "interrupted" &&
            isSubagentSessionFromEntry(
              targetSession.canonicalKey,
              targetSessionEntry,
              initialAcpMeta,
            )
          ) {
            dispatchMessage = `${formatSystemTurnPrompt(RESTART_RECOVERY_INTERRUPTION_NOTE)}\n\n${dispatchMessage}`;
          }
          const source = {
            agentId: requesterSession.agentId,
            sessionKey: requesterSession.canonicalKey,
            storePath: requesterSession.readSource?.path ?? requesterSession.storePath,
            entry: requesterSessionEntry,
          };
          const targetEndpoint = () => ({
            agentId: targetSession.agentId,
            sessionKey: targetSession.canonicalKey,
            storePath: targetSession.readSource?.path ?? targetSession.storePath,
            entry: targetSessionEntry,
          });
          // Main aliases bypass the explicit-key missing-session probe.
          const canCreateTarget =
            visibleSession.missing ||
            (allowMissingKey && (sessionKey === "main" || sessionKey === mainKey));
          let communication: Awaited<ReturnType<typeof prepareSessionsSendCommunication>>;
          try {
            communication = await prepareSessionsSendCommunication({
              config: cfg,
              source,
              target: targetEndpoint(),
              message,
              dispatchMessage,
              inputProvenance,
              access: {
                sandboxed: opts?.sandboxed,
                watch: params.watch === true,
                requesterOwned: visibleSession.requesterOwned,
                authorizationTargetSessionKey: authorizationTargetKey,
                expectedSessionId,
              },
              assertSourceCurrent: opts?.assertSourceCurrent,
              assertAccessCurrent: access.assertCurrent,
              signal: opts?.signal,
              callGateway: sendGatewayCall,
              ensureTarget: canCreateTarget
                ? async (assertCurrent) => {
                    const created = await createConfiguredAgentMainSession({
                      mode,
                      inheritedToolPolicySource: opts?.inheritedToolPolicySource,
                      callGateway: sendGatewayCall,
                      agentId: targetAgentId,
                      sessionKey: resolvedKey,
                      requesterSessionKey,
                      useTrustedInProcessCreation: opts?.callGateway === undefined,
                      assertCurrent,
                    });
                    if (!created.ok) {
                      throw new Error(created.error);
                    }
                    targetSession = await readSession(resolvedKey, targetAgentId);
                    targetSessionEntry = targetSession.store[targetSession.canonicalKey];
                    return targetEndpoint();
                  }
                : undefined,
            });
          } catch (error) {
            return sendFailure("forbidden", formatErrorMessage(error), displayKey, runId);
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
            if (mode === "notify") {
              return await notifySessionsSendSession({
                message,
                inputProvenance,
                sessionKey: resolvedKey,
                targetAgentId,
                idempotencyKey,
                runId,
                displayKey,
                assertCurrent: communication.assertCurrent,
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
                assertCurrent: communication.assertCurrent,
                targetAgentId,
                sessionKey: resolvedKey,
                displayKey,
                runId,
                expectedSessionId,
                sendParams,
                callGateway: communication.callGateway,
              });
            }
            const ownChild = targetSessionEntry?.spawnedBy === requesterSession.canonicalKey;
            const startParams: Parameters<typeof dispatchSessionsSendFollowup>[0] = {
              cfg,
              callGateway: communication.callGateway,
              runId,
              mode,
              sendParams,
              sourceOrigin: sameSession ? requesterOrigin : undefined,
              sessionKey: mode || ownChild ? resolvedKey : displayKey,
              sessionStoreTarget: targetSession,
              deliveryTimeoutMs: replyTimeoutMs,
              allowActiveRunQueueDelivery: timeoutSeconds === 0,
              expectedSessionId,
              preparedTargetSessionId: targetSessionEntry?.sessionId,
              assertSendCurrent: communication.assertCurrent,
              prepareFallback: async (fallbackSessionKey) => {
                const fallback = await readSession(fallbackSessionKey, targetAgentId);
                return prepareSessionsSendCommunication({
                  config: cfg,
                  source,
                  target: {
                    agentId: fallback.agentId,
                    sessionKey: fallback.canonicalKey,
                    storePath: fallback.readSource?.path ?? fallback.storePath,
                    entry: fallback.store[fallback.canonicalKey],
                  },
                  message,
                  dispatchMessage: sendParams.message,
                  inputProvenance,
                  access: { sandboxed: communication.sourceSandboxed },
                  assertSourceCurrent: opts?.assertSourceCurrent,
                  signal: opts?.signal,
                  callGateway: sendGatewayCall,
                });
              },
            };
            const replyContext = prepareSessionsSendReplyContext({
              requesterTarget: requesterSession,
              requesterSessionId: opts?.agentSessionId,
              callerOwnsCompletion:
                opts?.completionOwner === "caller" || access.basis === "scoped-grant",
              requesterIsSubagent,
              ownedTask: communication.ownedTask,
              isIsolatedCronRequester,
              targetIsSubagent,
              requesterSessionKey: requesterSession.canonicalKey,
              targetSession: targetSessionEntry
                ? { ...targetSessionEntry, acp: targetAcpMeta }
                : undefined,
              context: {
                callGateway: gatewayCall,
                targetSessionKey: resolvedKey,
                targetAgentId,
                displayKey,
                replyTimeoutMs,
                requesterSessionKey,
                requesterAgentId,
                requesterOrigin,
                requesterChannel,
              },
            });
            const { start, completion, registryCompletion, watchField } =
              await dispatchSessionsSendFollowup(startParams, replyContext, {
                message,
                ownChild,
                nativeChild: !targetAcpMeta,
                requesterSessionKey: requesterSession.canonicalKey,
                requesterAgentId,
                requesterTurnRunId: opts?.requesterTurnRunId,
                targetSession: targetSessionEntry,
                withRequesterAuthority,
                watch: params.watch === true,
              });
            return await finishSessionsSendReply({
              start,
              completion,
              registryCompletion,
              watchField,
              replyContext,
              targetSession,
              cfg,
              requesterAgentId,
              promptedAt,
              timeoutSeconds,
              timeoutMs,
              targetIsSubagent,
              isIsolatedCronRequester,
            });
          } finally {
            communication.close();
          }
        },
      });
    }),
  };
  const execute = tool.execute;
  tool.execute = (...args) => withSessionsSendRequesterSource(opts, () => execute(...args));
  return tool;
}
