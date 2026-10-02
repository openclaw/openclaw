import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { shouldResumeParentSubagent } from "../../gateway/session-subagent-resume.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store-lookup.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
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
import { jsonResult, readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  isExpectedSessionLookupMiss,
  recordSessionToolActionFact,
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
import { dispatchSessionsSendFollowup } from "./sessions-send-followup.js";
import { sendFailure } from "./sessions-send-helpers.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import { captureSessionsSendResumeCaller, resumeSessionsSendTask } from "./sessions-send-resume.js";
import {
  createConfiguredAgentMainSession,
  isConfiguredAgentMainSessionKey,
  notifySessionsSendSession,
  resolveConfiguredAgentMainSessionKey,
} from "./sessions-send-tool.delivery.js";
import { SessionsSendToolSchema, SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

const log = createSubsystemLogger("agents/sessions-send");

const NO_REPLY_MESSAGE = "No visible reply or pending delivery. Continue or retry if needed.";

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
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args) => {
      const params = isRecord(args) ? args : {};
      const promptedAt = Date.now();
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const message = readToolStringParam(params, "message", { required: true, trim: false });
      if (!message.trim()) {
        throw new ToolInputError("message required");
      }
      const mode = readToolStringParam(params, "mode");
      if (
        mode !== undefined &&
        mode !== "notify" &&
        mode !== "steer" &&
        mode !== "followup" &&
        mode !== "resume"
      ) {
        throw new ToolInputError("mode must be notify, steer, followup, or resume");
      }
      const resumeCaller =
        mode === undefined || mode === "resume" ? captureSessionsSendResumeCaller() : undefined;
      if (mode === "resume" && !resumeCaller) {
        return sendFailure("forbidden", "Task resume requires an admitted parent tool caller.");
      }
      if (
        mode === "resume" &&
        (params.watch === true || (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 0) > 0)
      ) {
        throw new ToolInputError(
          "mode=resume returns admission only; omit watch and timeoutSeconds or set timeoutSeconds=0. The task owner delivers completion.",
        );
      }
      const timeoutSeconds =
        mode === "steer" || mode === "resume"
          ? 0
          : (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30);
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
        let resolvedKey;
        try {
          const resolved = await gatewayCall<{ agentId?: string; key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
          resolvedTargetAgentId = normalizeOptionalString(resolved?.agentId);
        } catch (err) {
          if (isExpectedSessionLookupMiss(err)) {
            resolvedKey = "";
          } else {
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
        defaultAgentId:
          resolvedSession.agentId ??
          resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
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
      const resolvedKey = visibleSession.key;
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
      const mayUseRequesterForLiteralSentinel =
        isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId;
      const requesterSessionKey = opts?.agentSessionKey ? effectiveRequesterKey : undefined;
      const requesterSession = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: effectiveRequesterKey,
        agentId: requesterAgentId,
        readOnly: true,
        exactRead: true,
        clone: false,
        projection: "full",
      });
      const requesterSessionEntry = requesterSession.store[requesterSession.canonicalKey];
      const requesterSessionId = opts?.agentSessionId ?? requesterSessionEntry?.sessionId;
      const requesterContinuationSession = requesterSessionId
        ? {
            sessionId: requesterSessionId,
            lifecycleRevision: requesterSessionEntry?.lifecycleRevision,
          }
        : undefined;
      const requesterDeliveryGeneration =
        requesterSessionEntry && requesterContinuationSession
          ? {
              agentId: requesterSession.agentId,
              storePath: requesterSession.storePath,
              sessionKey: requesterSession.canonicalKey,
              ...requesterContinuationSession,
              lifecycleRevision: requesterContinuationSession.lifecycleRevision ?? null,
            }
          : undefined;
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
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const replyTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
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
          if (visibleSession.missing) {
            if (mode === "steer" || mode === "notify" || mode === "resume") {
              return sendFailure(
                "error",
                "Cannot notify, steer, or resume a missing session. Use mode=followup to start a new turn.",
                displayKey,
                runId,
              );
            }
            const createdSession = await createConfiguredAgentMainSession({
              callGateway: gatewayCall,
              agentId: targetAgentId,
              sessionKey: resolvedKey,
              requesterSessionKey,
              useTrustedInProcessCreation: opts?.callGateway === undefined,
            });
            if (!createdSession.ok) {
              return sendFailure("error", createdSession.error, displayKey);
            }
          }

          const requesterChannel = opts?.agentChannel;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          const targetSession = resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key: resolvedKey,
            agentId: targetAgentId,
            readOnly: true,
            exactRead: true,
            clone: false,
            projection: "full",
          });
          const targetSessionEntry = targetSession.store[targetSession.canonicalKey];
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
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
            ...(requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
          };
          if (mode === "notify") {
            return await notifySessionsSendSession({
              message,
              inputProvenance,
              sessionKey: resolvedKey,
              targetAgentId,
              idempotencyKey,
              runId,
              displayKey,
            });
          }
          const sendParams = {
            message: annotateInterSessionPromptText(message, inputProvenance),
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
              targetAgentId,
              sessionKey: resolvedKey,
              displayKey,
              runId,
              expectedSessionId,
              sendParams,
              callGateway: gatewayCall,
            });
          }
          // ACP background tasks already report to their parent through task completion.
          const skipTaskReplyFlow = isRequesterParentOfBackgroundAcpSession(
            targetSessionEntry ? { ...targetSessionEntry, acp: targetAcpMeta } : undefined,
            effectiveRequesterKey,
          );
          // Child reports, registered tasks, and exact-incarnation grants own their completion.
          const replyMode =
            requesterIsSubagent || skipTaskReplyFlow || expectedSessionId || isIsolatedCronRequester
              ? undefined
              : targetIsSubagent
                ? "one-way"
                : "peer";

          const ownChild = targetSessionEntry?.spawnedBy === effectiveRequesterKey;
          const startParams: Parameters<typeof dispatchSessionsSendFollowup>[0] = {
            cfg,
            callGateway: gatewayCall,
            runId,
            mode,
            sendParams,
            sourceOrigin: sameSession ? requesterOrigin : undefined,
            sessionKey: mode || ownChild ? resolvedKey : displayKey,
            sessionStoreTarget: targetSession,
            deliveryTimeoutMs: replyTimeoutMs,
            allowActiveRunQueueDelivery: timeoutSeconds === 0,
            expectedSessionId,
          };
          const replyContext: Parameters<typeof dispatchSessionsSendFollowup>[1] = {
            callGateway: gatewayCall,
            targetSessionKey: resolvedKey,
            targetAgentId,
            displayKey,
            replyTimeoutMs,
            replyMode,
            requesterSessionKey,
            requesterAgentId,
            requesterSession: requesterContinuationSession,
            requesterDeliveryGeneration,
            requesterOrigin,
            requesterChannel,
          };
          const { start, completion, registryCompletion, watchField } =
            await dispatchSessionsSendFollowup(startParams, replyContext, {
              message,
              ownChild,
              nativeChild: !targetAcpMeta,
              requesterSessionKey: effectiveRequesterKey,
              requesterAgentId,
              requesterTurnRunId: opts?.requesterTurnRunId,
              targetSession: targetSessionEntry,
              withRequesterAuthority,
              watch: params.watch === true,
            });
          if (!start.ok) {
            return start.result;
          }
          const acceptedTargetSessionKey = start.a2aSessionKey ?? resolvedKey;
          // Steering and registered completion owners retain their delivery obligation.
          const delayedDelivery = {
            status:
              registryCompletion || (replyMode && start.targetDisposition === "queued")
                ? "pending"
                : "skipped",
          } as const;
          recordSessionToolActionFact({
            operation: "send",
            fact: "committed",
            targetAgentId,
            targetSessionKey: acceptedTargetSessionKey,
          });
          try {
            const acceptedTarget = start.a2aSessionKey
              ? resolveGatewaySessionStoreTargetWithStore({
                  cfg,
                  key: acceptedTargetSessionKey,
                  agentId: targetAgentId,
                  readOnly: true,
                  exactRead: true,
                  clone: false,
                  projection: "full",
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
          const accepted = () =>
            jsonResult({
              runId,
              status: "accepted",
              sessionKey: displayKey,
              targetDisposition: start.targetDisposition,
              delivery: delayedDelivery,
              ...watchField,
            });
          const startReplyFlow = (notifyRequesterOnWaitFailure: boolean) =>
            startSessionsSendReplyFlow({
              ...replyContext,
              runId,
              completion,
              skip: registryCompletion || delayedDelivery.status === "skipped",
              targetSessionKey: acceptedTargetSessionKey,
              displayKey: start.a2aSessionKey ?? displayKey,
              notifyRequesterOnWaitFailure:
                notifyRequesterOnWaitFailure && !isIsolatedCronRequester,
            });
          if (timeoutSeconds === 0) {
            await startReplyFlow(true);
            return accepted();
          }

          const result = completion
            ? await completion.take(timeoutMs)
            : await waitForAgentRunReply({ runId, timeoutMs, callGateway: gatewayCall });
          if (!result) {
            await startReplyFlow(true);
            return accepted();
          }
          completion?.close();

          if (result.status === "timeout") {
            if (result.pendingError === true && result.error?.trim()) {
              await startReplyFlow(targetIsSubagent);
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
              await startReplyFlow(true);
              return accepted();
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
            ? { status: "ok" as const, delivery: { status: "skipped" as const }, reply }
            : {
                status: "no_reply" as const,
                message: result.sourceReplyDelivered
                  ? "The target delivered its final reply directly to its source conversation. Do not resend."
                  : NO_REPLY_MESSAGE,
              };
          return jsonResult({ runId, sessionKey: displayKey, ...response, ...watchField });
        },
      });
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
