import crypto from "node:crypto";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntryAsync } from "../../acp/runtime/session-meta-readonly.js";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { getRuntimeConfig } from "../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { resolveSessionStoreKey } from "../../gateway/session-store-key.js";
import { shouldResumeParentSubagent } from "../../gateway/session-subagent-resume.js";
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
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { bindRequesterYieldCronAuthority } from "../cron-creator-authority-context.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { ToolInputError } from "../tool-input-error.js";
import type { AnyAgentTool } from "./common.js";
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
  buildSessionsSendAgentParams,
  callSessionsSendGateway,
  createConfiguredAgentMainSession,
  isConfiguredAgentMainSessionKey,
  notifySessionsSendSession,
  resolveConfiguredAgentMainSessionKey,
} from "./sessions-send-tool.delivery.js";
import {
  formatUnknownAgentError,
  readSessionsSendMessage,
  readSessionsSendMode,
  readSessionsSendTarget,
  readSessionsSendTimeout,
} from "./sessions-send-tool.input.js";
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
      : describeSessionsSendTool({
          allowThreadTargets:
            (opts?.config ?? getRuntimeConfig()).tools?.sessions?.allowThreadTargets === true,
        }),
    parameters: opts?.workerPlacement ? PlacedSessionsSendSchema : SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args) => {
      const params = isRecord(args) ? args : {};
      const promptedAt = Date.now();
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const sendGatewayCall = opts?.callGateway ?? callSessionsSendGateway;
      const message = readSessionsSendMessage(params);
      const mode = readSessionsSendMode(params);
      const resumeCaller =
        mode === undefined || mode === "resume" ? captureSessionsSendResumeCaller() : undefined;
      if (mode === "resume" && !resumeCaller) {
        return sendFailure("forbidden", "Task resume requires an admitted parent tool caller.");
      }
      const timeoutSeconds = readSessionsSendTimeout(params, mode);
      const context = resolveSessionToolContext(opts);
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility,
        a2aPolicy,
      } = context;
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

      const sendScope = { ...context, requesterAgentId };
      const targetInput = readSessionsSendTarget(params, sendScope);
      if (!targetInput.ok) {
        return sendFailure("error", targetInput.error);
      }
      const { sessionKeyParam, labelParam, labelAgentIdInput, explicitTargetAgentId } = targetInput;

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
          return sendFailure("error", formatUnknownAgentError(sendScope, labelAgentIdInput));
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

        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ agentId?: string; key: string }>({
            method: "sessions.resolve",
            params: {
              label: labelParam,
              ...(explicitTargetAgentId ? { agentId: explicitTargetAgentId } : {}),
              ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
            },
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
          return sendFailure(
            restrictToSpawned ? "forbidden" : "error",
            restrictToSpawned
              ? "Session not visible from this sandboxed agent session."
              : `No session found with label: ${labelParam}`,
          );
        }
        sessionKey = resolvedKey;
        resolvedLabelKey = resolvedKey;
      }

      if (!sessionKey) {
        return sendFailure("error", "Either sessionKey or label is required");
      }
      const allowMissingKey = isConfiguredAgentMainSessionKey({ cfg, sessionKey, mainKey });
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
        parseAgentSessionKey(resolvedKey)?.agentId ??
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
        await readAcpSessionMetaForEntryAsync({
          sessionKey: requesterSession.canonicalKey,
          agentId: requesterSession.agentId,
          cfg,
          entry: requesterSessionEntry,
        }),
      );
      const timeoutMs = finiteSecondsToTimerSafeMilliseconds(timeoutSeconds) ?? 0;
      const replyTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const runId = opts?.idempotencyKey ?? crypto.randomUUID();
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
      if (
        cfg.tools?.sessions?.allowThreadTargets !== true &&
        resolveSessionThreadInfo(resolvedKey).threadId
      ) {
        return sendFailure(
          "error",
          "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead, or enable tools.sessions.allowThreadTargets.",
          unresolvedDisplayKey,
        );
      }
      const authorizationTargetKey =
        isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId
          ? effectiveRequesterKey
          : !parseAgentSessionKey(resolvedKey)
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
      // A durable parent's binding is not temporary, but explicit invocation ceilings remain.
      const persistentChildAccess =
        access.basis === "parent-lineage" && opts?.expectedTargetSessionId === undefined;
      if (mode === "notify" && expectedSessionId && !persistentChildAccess) {
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
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          let targetSession = await readSession(resolvedKey, targetAgentId);
          let targetSessionEntry = targetSession.store[targetSession.canonicalKey];
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceChannel: opts?.agentChannel,
            sourceTool: "sessions_send",
            ...(requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
          };
          let dispatchMessage = annotateInterSessionPromptText(message, inputProvenance);
          let targetAcpMeta = await readAcpSessionMetaForEntryAsync({
            sessionKey: targetSession.canonicalKey,
            agentId: targetSession.agentId,
            cfg,
            entry: targetSessionEntry,
          });
          if (
            !targetAcpMeta &&
            targetSessionEntry?.status === "interrupted" &&
            isSubagentSessionFromEntry(targetSession.canonicalKey, targetSessionEntry)
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
                controllerOnly: access.basis === "live-controller",
                expectedSessionId,
              },
              assertSourceCurrent: opts?.assertSourceCurrent,
              assertAccessCurrent: access.assertCurrent,
              signal: opts?.signal,
              callGateway: sendGatewayCall,
              // Main aliases bypass the explicit-key missing-session probe.
              ensureTarget:
                visibleSession.missing ||
                (allowMissingKey && (sessionKey === "main" || sessionKey === mainKey))
                  ? async (assertCurrent) => {
                      await createConfiguredAgentMainSession({
                        mode,
                        inheritedToolPolicySource: opts?.inheritedToolPolicySource,
                        callGateway: sendGatewayCall,
                        agentId: targetAgentId,
                        sessionKey: resolvedKey,
                        requesterSessionKey,
                        useTrustedInProcessCreation: opts?.callGateway === undefined,
                        assertCurrent,
                      });
                      targetSession = await readSession(resolvedKey, targetAgentId);
                      targetSessionEntry = targetSession.store[targetSession.canonicalKey];
                      targetAcpMeta = await readAcpSessionMetaForEntryAsync({
                        sessionKey: targetSession.canonicalKey,
                        agentId: targetSession.agentId,
                        cfg,
                        entry: targetSessionEntry,
                      });
                      return targetEndpoint();
                    }
                  : undefined,
            });
          } catch (error) {
            return sendFailure("forbidden", formatErrorMessage(error), displayKey, runId);
          }
          try {
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
                runId,
                displayKey,
                assertCurrent: communication.assertCurrent,
              });
            }
            const sendParams = buildSessionsSendAgentParams({
              message: dispatchMessage,
              agentId: targetAgentId,
              sessionKey: resolvedKey,
              idempotencyKey: runId,
              nativeChild: targetIsSubagent && !targetAcpMeta,
              inputProvenance,
            });
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
              admissionConfig: communication.admissionConfig,
              callGateway: communication.callGateway,
              captureReplyAdmission: communication.captureReplyAdmission,
              runId,
              mode,
              callDurableGateway: communication.callDurableGateway,
              sendParams,
              sourceOrigin: sameSession ? requesterOrigin : undefined,
              sessionKey: resolvedKey,
              sessionStoreTarget: targetSession,
              allowActiveRunQueueDelivery: !sameSession && timeoutSeconds === 0,
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
                requesterChannel: opts?.agentChannel,
              },
            });
            const { start, completion, registryCompletion, watchField } =
              await dispatchSessionsSendFollowup(startParams, replyContext, {
                message,
                ownChild,
                persistentChildAccess,
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
              requesterTurnRunId: opts?.requesterTurnRunId,
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
