import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import {
  isSyntheticSourceReplyTurn,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SilentReplyPromptMode } from "../../agents/system-prompt.types.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { copyChannelParticipantAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { hasControlCommand } from "../command-detection.js";
import {
  isNativeCommandTurn,
  isTextSlashCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import { normalizeThinkLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { applySessionHints } from "./body.js";
import { resolveTurnModelOverride } from "./dispatch-from-config.harness-defaults.js";
import { resolveReplyPolicyConversationType } from "./get-reply-conversation-type.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import {
  buildExecOverridePromptHint,
  finishReplyPreparation,
  hasInboundHistoryBody,
  hasReplyTargetContext,
} from "./get-reply-run-helpers.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { buildGroupIntro, buildSourceConversationContext } from "./groups.js";
import { hasInboundMedia } from "./inbound-media.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  formatActiveGoalContext,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { buildReplyPromptEnvelope, buildReplyPromptEnvelopeBase } from "./prompt-prelude.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import {
  resolveBareResetBootstrapFileAccess,
  resolveBareSessionResetPromptState,
} from "./session-reset-prompt.js";
import { resolveSessionStableReplyMode } from "./session-stable-reply-mode.js";
import {
  isInternalSourceReplyChannel,
  resolveSourceReplyExpectation,
} from "./source-reply-delivery-mode.js";
import { shouldApplyStartupContext, buildSessionStartupContextPrelude } from "./startup-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

export async function prepareReplyRunContext(params: RunPreparedReplyParams) {
  const {
    ctx,
    sessionCtx,
    conversation,
    cfg,
    agentId,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    allowTextCommands,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    provider,
    model,
    perMessageQueueMode,
    typing,
    opts,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    storePath,
    workspaceDir: configuredWorkspaceDir,
    sessionEntryHandle,
    sessionStore,
  } = params;
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({ agentId, cfg, ctx, sessionKey });
  const { resolvedElevatedLevel, execOverrides, abortedLastRun, sessionEntry } = params;
  const isHeartbeat = opts?.isHeartbeat === true;
  const isInternalEvent = opts?.internalEventExecution !== undefined;
  const explicitThinkingLevelOverride = normalizeThinkLevel(opts?.thinkingLevelOverride);
  const effectiveQueueMode = opts?.queueModeOverride ?? perMessageQueueMode;
  const traceAttributes = {
    provider,
    hasSessionKey: Boolean(sessionKey),
    isHeartbeat,
    queueMode: effectiveQueueMode ?? "configured",
  };
  const traceRunPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    measureDiagnosticsTimelineSpan(name, run, {
      phase: "agent-turn",
      config: cfg,
      attributes: traceAttributes,
    });
  const promptSessionCtx = { ...sessionCtx, ...conversation.fields };
  copyChannelParticipantAdmissionEvidence(ctx, promptSessionCtx);
  if (sessionCtx !== ctx) {
    copyChannelParticipantAdmissionEvidence(sessionCtx, promptSessionCtx);
  }
  const inboundEventKind = promptSessionCtx.InboundEventKind;
  const isInternalPromptChannel = isInternalSourceReplyChannel(promptSessionCtx);
  const sourceReplyDeliveryMode =
    inboundEventKind === "room_event" && !isInternalPromptChannel
      ? "message_tool_only"
      : isInternalPromptChannel && opts?.sourceReplyDeliveryMode === undefined
        ? "automatic"
        : opts?.sourceReplyDeliveryMode;
  // Direct resolver callers (heartbeat wakes, system events) skip dispatch's
  // stable-mode injection; resolve the same session-stable fact here so their
  // binding facts and messageToolPolicyHash match dispatched chat turns —
  // otherwise chat<->heartbeat transitions ping-pong the CLI session (#121485).
  // Synthetic turns must not fall back to their effective turn mode: a
  // response-tool heartbeat's message_tool_only is per-turn enforcement, not
  // session policy, and hashing it recreates the ping-pong.
  const isSyntheticTurn = isSyntheticSourceReplyTurn({
    inputProvenance: promptSessionCtx.InputProvenance,
    isHeartbeat,
  });
  const sessionPromptSourceReplyDeliveryMode =
    opts?.sessionPromptSourceReplyDeliveryMode ??
    (isSyntheticTurn && sessionEntry
      ? await resolveSessionStableReplyMode({
          cfg,
          ctx: { ...promptSessionCtx, CommandAuthorized: false },
          sessionEntry,
          sessionAgentId: agentId,
          sessionKey,
          sessionStore,
          turnModelOverride: resolveTurnModelOverride(opts),
        })
      : sourceReplyDeliveryMode);
  const silentReplyConversationType = resolveReplyPolicyConversationType(
    promptSessionCtx,
    ctx.SessionKey,
  );
  const silentReplySettings = resolveSilentReplySettings({
    cfg,
    sessionKey: runtimePolicySessionKey,
    surface: promptSessionCtx.Surface ?? promptSessionCtx.Provider,
    conversationType: silentReplyConversationType,
  });
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: isFastTestRuntimeEnv(),
  });
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider,
    modelId: model,
    agentId,
    sessionKey: runtimePolicySessionKey,
    sessionEntry,
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      defaultLevel: resolvedElevatedLevel ?? "off",
    },
  });

  const isFirstTurnInSession = isNewSession || !systemSent;
  const isGroupChat =
    promptSessionCtx.ChatType === "group" || promptSessionCtx.ChatType === "channel";
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: resolveAgentConfig(cfg, agentId)?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned: ctx.WasMentioned === true,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
    sourceReplyDeliveryMode,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const sourceConversationContext = (mode: typeof sourceReplyDeliveryMode) =>
    buildSourceConversationContext({
      sourceReplyDeliveryMode: mode,
      sessionCtx: promptSessionCtx,
      silentReplyPolicy: silentReplySettings.policy,
      silentToken: SILENT_REPLY_TOKEN,
    });
  const sourceConversationContextByMode = {
    automatic: sourceConversationContext("automatic"),
    message_tool_only: sourceConversationContext("message_tool_only"),
  };
  // CLI sessions keep their creation-time conversation prompt. Embedded attempts
  // can instead select the variant owned by their final prepared harness.
  const sessionStableConversationContext =
    sourceConversationContextByMode[sessionPromptSourceReplyDeliveryMode ?? "automatic"];
  // Claude CLI fixes the system prompt at session creation; group intro must stay session-stable.
  const groupIntro = isGroupChat
    ? buildGroupIntro({ activation: conversation.activation, defaultActivation })
    : "";
  const terminalReplyExpectation = resolveSourceReplyExpectation({
    ctx: promptSessionCtx,
    cfg,
    isHeartbeat,
  });
  const replyOperationRunState = resolveReplyOperationRunState(opts);
  const setReplyCompletion = (evidence: Parameters<typeof resolveReplyCompletion>[1]) => {
    if (replyOperationRunState) {
      replyOperationRunState.replyCompletion = resolveReplyCompletion(
        terminalReplyExpectation,
        evidence,
      );
    }
  };
  setReplyCompletion("empty");
  const groupSystemPrompt = normalizeOptionalString(promptSessionCtx.GroupSystemPrompt) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? promptSessionCtx : { ...promptSessionCtx, ThreadStarterBody: undefined },
    cfg,
    { includeFormattingHints: !useFastReplyRuntime },
  );
  const execOverridePromptHint = buildExecOverridePromptHint({
    execOverrides,
    elevatedLevel: resolvedElevatedLevel,
    fullAccessAvailable: fullAccessState.available,
    fullAccessBlockedReason: fullAccessState.blockedReason,
  });
  const staticSystemPromptParts = [
    sessionStableConversationContext,
    groupIntro,
    groupSystemPrompt,
    execOverridePromptHint,
  ].filter(Boolean);
  const extraSystemPromptParts = [inboundMetaPrompt, ...staticSystemPromptParts].filter(Boolean);
  const sourceConversationContextPromptOffset = sessionStableConversationContext
    ? inboundMetaPrompt
      ? inboundMetaPrompt.length + 2
      : 0
    : undefined;
  const extraSystemPromptStatic = staticSystemPromptParts.join("\n\n");
  const cliSessionBindingFacts = {
    extraSystemPromptStatic,
    ...(sessionPromptSourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode }
      : {}),
  };
  const silentReplyPromptMode: SilentReplyPromptMode =
    sessionStableConversationContext || sourceReplyDeliveryMode === "message_tool_only"
      ? "none"
      : "generic";
  const baseBody = sessionCtx.agentText ?? "";
  const rawBodyTrimmed = (ctx.commandText ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const softResetTriggered = command.softResetTriggered === true;
  const softResetTail = command.softResetTail?.trim() ?? "";
  const effectiveResetTriggered = resetTriggered || softResetTriggered;
  const hasCurrentReplyTargetContext =
    hasReplyTargetContext(ctx) || hasReplyTargetContext(sessionCtx);
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/i.test(normalizedCommandBody);
  const commandTurn = resolveCommandTurnContext(ctx);
  const canInterpretCommands = ctx.CommandInterpretationSuppressed !== true;
  const isRegisteredWholeMessageCommand =
    isWholeMessageCommand && (hasControlCommand(rawBodyTrimmed, cfg) || isResetOrNewCommand);
  const isActiveCommandTurn =
    canInterpretCommands &&
    (isNativeCommandTurn(commandTurn) ||
      (allowTextCommands &&
        (isTextSlashCommandTurn(commandTurn) || isRegisteredWholeMessageCommand)));
  if (
    isActiveCommandTurn &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    isRegisteredWholeMessageCommand
  ) {
    setReplyCompletion("blocked");
    opts?.onDeliberateSilentTerminalReply?.();
    return finishReplyPreparation(typing);
  }
  const isBareNewOrReset = /^\/(new|reset)$/i.test(normalizedCommandBody);
  const isBareSessionReset =
    canInterpretCommands &&
    (softResetTriggered ||
      (isNewSession &&
        (isBareNewOrReset ||
          (!hasCurrentReplyTargetContext &&
            baseBodyTrimmedRaw.length === 0 &&
            rawBodyTrimmed.length > 0))));
  const startupAction =
    softResetTriggered || /^\/reset(?:\s|$)/i.test(normalizedCommandBody) ? "reset" : "new";
  const sessionWorkspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
    execHost: sessionEntry?.execHost,
    runtimeBackendId: provider,
  });
  const workspaceDir = sessionWorkspaceOverride ?? configuredWorkspaceDir;
  const bareResetPromptState =
    isBareSessionReset && workspaceDir
      ? await resolveBareSessionResetPromptState({
          cfg,
          workspaceDir,
          isPrimaryRun: !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey),
          isCanonicalWorkspace: !sessionWorkspaceOverride,
          hasBootstrapFileAccess: () =>
            resolveBareResetBootstrapFileAccess({
              cfg,
              agentId,
              sessionKey,
              workspaceDir,
              modelProvider: provider,
              modelId: model,
            }),
        })
      : null;
  const startupContextPrelude =
    isBareSessionReset &&
    bareResetPromptState?.shouldPrependStartupContext !== false &&
    shouldApplyStartupContext({ cfg, action: startupAction })
      ? await buildSessionStartupContextPrelude({ workspaceDir, cfg })
      : null;
  // Directive routing already owns stripping and authorization; prepared text is final.
  const baseBodyFinal = isBareSessionReset ? (bareResetPromptState?.prompt ?? "") : baseBody;
  const hasUserBody =
    baseBodyFinal.trim().length > 0 ||
    softResetTail.length > 0 ||
    hasInboundHistoryBody(sessionCtx) ||
    hasCurrentReplyTargetContext;
  const hasMediaAttachment = hasInboundMedia(sessionCtx) || (opts?.images?.length ?? 0) > 0;
  if (!hasUserBody && !hasMediaAttachment) {
    // Skip onReplyStart when typing is suppressed (e.g. sendPolicy deny) —
    // otherwise channels that wire onReplyStart to typing indicators leak
    // visible signals even though outbound delivery is suppressed.
    if (!suppressTyping) {
      await typing.onReplyStart();
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    return finishReplyPreparation(typing, () => ({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    }));
  }

  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const inboundUserContextSessionCtx = isNewSession
    ? {
        ...sessionCtx,
        ...(normalizeOptionalString(sessionCtx.ThreadHistoryBody)
          ? { InboundHistory: undefined, ThreadStarterBody: undefined }
          : {}),
      }
    : { ...sessionCtx, ThreadStarterBody: undefined };
  let inboundContextSessionEntry =
    isHeartbeat || isInternalEvent
      ? undefined
      : ((sessionKey !== undefined ? sessionStore?.[sessionKey] : undefined) ??
        sessionEntryHandle?.getCurrent() ??
        sessionEntry);
  // Synthetic turns retain routing facts without inventing user-role inbound context.
  const buildInboundContextState = () => ({
    activeGoalContext: formatActiveGoalContext(inboundContextSessionEntry),
    inboundUserContext:
      isHeartbeat || isInternalEvent
        ? ""
        : buildInboundUserContextPrefix(
            inboundUserContextSessionCtx,
            envelopeOptions,
            inboundContextSessionEntry,
          ),
  });
  let { activeGoalContext, inboundUserContext } = buildInboundContextState();
  const refreshInboundContextAfterAdmissionWait = async () => {
    if (isHeartbeat || isInternalEvent) {
      return;
    }
    inboundContextSessionEntry =
      storePath && sessionKey
        ? loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })
        : (sessionEntryHandle?.getCurrent() ??
          (sessionKey !== undefined ? sessionStore?.[sessionKey] : undefined) ??
          sessionEntry);
    ({ activeGoalContext, inboundUserContext } = buildInboundContextState());
  };
  const inboundUserContextPromptJoiner = resolveInboundUserContextPromptJoiner(sessionCtx);
  const getPromptEnvelopeParams = (): Parameters<typeof buildReplyPromptEnvelopeBase>[0] => ({
    ctx,
    sessionCtx,
    baseBody: baseBodyFinal,
    hasUserBody,
    inboundUserContext,
    activeGoalContext,
    inboundUserContextPromptJoiner,
    isBareSessionReset,
    startupAction,
    startupContextPrelude,
    softResetTail,
    isHeartbeat,
    inboundEventKind,
    sourceReplyDeliveryMode,
  });
  const promptEnvelopeBase = buildReplyPromptEnvelopeBase(getPromptEnvelopeParams());
  const prefixedBodyBase = applySessionHints({
    baseBody: promptEnvelopeBase.effectiveBaseBody,
    abortedLastRun,
    abortKey: command.abortKey,
  });
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);

  return {
    kind: "ready",
    params,
    runtimePolicySessionKey,
    isHeartbeat,
    explicitThinkingLevelOverride,
    effectiveQueueMode,
    traceRunPhase,
    promptSessionCtx,
    inboundEventKind,
    sourceReplyDeliveryMode,
    silentReplyPromptMode,
    useFastReplyRuntime,
    thinkingRuntime,
    fullAccessState,
    isFirstTurnInSession,
    extraSystemPromptParts,
    sourceConversationContextByMode,
    sourceConversationContextPromptOffset,
    extraSystemPromptStatic,
    cliSessionBindingFacts,
    baseBodyTrimmedRaw,
    effectiveResetTriggered,
    isBareSessionReset,
    workspaceDir,
    skillsWorkspaceDir: configuredWorkspaceDir,
    hasUserBody,
    shouldInjectGroupIntro,
    typingMode,
    prefixedBodyBase,
    sessionEntry,
    isMainSession,
    buildPromptBodies: (
      additions: Pick<
        Parameters<typeof buildReplyPromptEnvelope>[0],
        "prefixedBody" | "threadContextNote" | "systemEventBlocks" | "media"
      >,
    ) => buildReplyPromptEnvelope({ ...getPromptEnvelopeParams(), ...additions }),
    refreshInboundContextAfterAdmissionWait,
    terminalReplyExpectation,
  } as const;
}

export type PreparedReplyRunContext = Extract<
  Awaited<ReturnType<typeof prepareReplyRunContext>>,
  { kind: "ready" }
>;
