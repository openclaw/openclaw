import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import { resolveRequestGitCoauthorPrompt } from "../../agents/git-coauthor-prompt.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import {
  isSyntheticSourceReplyTurn,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SilentReplyPromptMode } from "../../agents/system-prompt.types.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { copyChannelParticipantAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { normalizeMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { updateSessionControllerSourcePolicy } from "../../sessions/session-controller.mailbox.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { MEDIA_ONLY_USER_TEXT } from "../../sessions/user-turn-media.js";
import { hasControlCommand } from "../command-detection.js";
import {
  isExplicitFollowupCommandTurn,
  isNativeCommandTurn,
  isTextSlashCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import { resolveInternalTurnTranscript } from "../internal-turn-source.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import { getRequesterProfile } from "../requester-profile.js";
import type { TemplateContext } from "../templating.js";
import { normalizeThinkLevel } from "../thinking.js";
import { applySessionHints } from "./body.js";
import { appendChannelPromptContext } from "./channel-prompt-context.js";
import { resolveTurnModelOverride } from "./dispatch-from-config.harness-defaults.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import {
  buildExecOverridePromptHint,
  finishReplyPreparation,
  hasInboundHistoryBody,
  hasReplyTargetContext,
} from "./get-reply-run-helpers.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { buildGroupIntro, buildSourceConversationContext } from "./groups.js";
import { CURRENT_MESSAGE_MARKER } from "./history.js";
import { hasInboundMedia } from "./inbound-media.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  formatActiveGoalContext,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { readReplySourceInput } from "./reply-source-binding.js";
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

const ROOM_EVENT_PROMPT = "[OpenClaw room event]";
const ROOM_EVENT_PARTICIPATION_RULE =
  "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.";
const RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES = [
  "Conversation context (chronological, selected for current message):",
  "Chat history since last reply:",
  "Recent chat history:",
];

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
    isInternalPromptChannel ||
    terminalReplyExpectation === "result-required" ||
    sessionStableConversationContext ||
    sourceReplyDeliveryMode === "message_tool_only"
      ? "none"
      : "generic";
  const baseBody = sessionCtx.agentText ?? "";
  const rawBodyTrimmed = (ctx.commandText ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const softResetTriggered = command.softResetTriggered === true;
  const softResetTail = command.softResetTail?.trim() ?? "";
  const effectiveResetTriggered = resetTriggered || softResetTriggered;
  const sourceInput = readReplySourceInput(opts);
  if (sourceInput) {
    const policy = useFastReplyRuntime
      ? { mode: "collect" as const, debounceMs: 0, cap: 1, dropPolicy: "summarize" as const }
      : resolveQueueSettings({
          cfg,
          channel: sessionCtx.Provider,
          sessionEntry,
          inlineMode: effectiveQueueMode,
          inlineOptions: params.perMessageQueueOptions,
        });
    updateSessionControllerSourcePolicy(sourceInput, {
      ...policy,
      mode:
        isHeartbeat || inboundEventKind === "room_event"
          ? "followup"
          : effectiveResetTriggered
            ? "interrupt"
            : policy.mode,
    });
  }
  const hasCurrentReplyTargetContext =
    hasReplyTargetContext(ctx) || hasReplyTargetContext(sessionCtx);
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/i.test(normalizedCommandBody);
  const commandTurn = resolveCommandTurnContext(ctx);
  const canInterpretCommands =
    ctx.CommandInterpretationSuppressed !== true && !isExplicitFollowupCommandTurn(ctx);
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
    return finishReplyPreparation(typing, () => ({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    }));
  }

  const requestGitCredit =
    !isHeartbeat && !isInternalEvent
      ? await resolveRequestGitCoauthorPrompt({
          config: cfg,
          agentId,
          sessionKey,
          requesterProfileId: getRequesterProfile(ctx)?.id ?? readSessionInputProfileId(ctx),
        })
      : undefined;
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
  const refreshInboundContextAfterAdmissionWait = () => {
    if (isHeartbeat || isInternalEvent) {
      return;
    }
    inboundContextSessionEntry =
      sessionEntryHandle?.getCurrent() ??
      (sessionKey !== undefined ? sessionStore?.[sessionKey] : undefined) ??
      sessionEntry;
    ({ activeGoalContext, inboundUserContext } = buildInboundContextState());
  };
  const inboundUserContextPromptJoiner = resolveInboundUserContextPromptJoiner(sessionCtx);
  function formatRoomEventLine(context: TemplateContext, body: string): string {
    const messageId =
      normalizeOptionalString(context.MessageSid) ??
      normalizeOptionalString(context.MessageSidFull);
    const sender =
      normalizeOptionalString(context.SenderName) ??
      normalizeOptionalString(context.SenderUsername) ??
      normalizeOptionalString(context.SenderId);
    const prefix = [messageId ? `#${messageId}` : undefined, sender].filter(Boolean).join(" ");
    return prefix ? `${prefix}: ${body}` : body;
  }

  function resolveRoomEventBody(): string {
    const hasBaseBody = Boolean(normalizeOptionalString(baseBodyFinal));
    const hasCompletedAudioBody =
      hasBaseBody &&
      [ctx, sessionCtx].some(
        (context) =>
          context.MediaUnderstanding?.some((output) => output.kind === "audio.transcription") &&
          baseBodyFinal === context.agentText,
      );
    // Command text intentionally excludes machine transcripts. Prefer the
    // enriched body only when this event owns an audio output and the body is
    // still one of its canonical agent-text projections.
    return (
      (hasCompletedAudioBody ? baseBodyFinal : undefined) ??
      normalizeOptionalString(ctx.commandText) ??
      normalizeOptionalString(sessionCtx.commandText) ??
      (hasUserBody ? baseBodyFinal.trim() : undefined) ??
      MEDIA_ONLY_USER_TEXT
    );
  }

  function resolveRoomEventTranscriptBody(): string {
    return (
      normalizeOptionalString(sessionCtx.AmbientTranscriptBody) ??
      normalizeOptionalString(ctx.AmbientTranscriptBody) ??
      formatRoomEventLine(sessionCtx, resolveRoomEventBody())
    );
  }

  function resolvePerTurnDeliveryDirective(): string | undefined {
    if (inboundEventKind === "room_event") {
      return sourceReplyDeliveryMode === "message_tool_only"
        ? `${ROOM_EVENT_PARTICIPATION_RULE} To respond visibly, use message(action=send); your final text here stays private either way.`
        : ROOM_EVENT_PARTICIPATION_RULE;
    }
    if (inboundEventKind === "user_request" && sourceReplyDeliveryMode === "message_tool_only") {
      return MESSAGE_TOOL_ONLY_DELIVERY_HINT;
    }
    return undefined;
  }

  // The current event itself is the user turn body; the context block carries
  // only the marker, the room backlog, and the reply-policy directive so no
  // fact is stated twice in one request.
  function buildRoomEventContext(roomContext: string, deliveryDirective?: string): string {
    const roomContextBlock = roomContext.trim() ? `Room context:\n${roomContext.trim()}` : "";
    return [ROOM_EVENT_PROMPT, roomContextBlock, deliveryDirective].filter(Boolean).join("\n\n");
  }

  function buildResumableRoomContext(roomContext: string): string {
    return roomContext
      .split(/\n{2,}/u)
      .filter(
        (block) =>
          !RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES.some((prefix) => block.startsWith(prefix)),
      )
      .join("\n\n");
  }

  const buildReplyPromptEnvelopeBase = () => {
    const isRoomEvent = inboundEventKind === "room_event";
    const normalizedInboundUserContext = inboundUserContext.trim();
    const deliveryDirective = resolvePerTurnDeliveryDirective();
    const resumableRoomEventContext = isRoomEvent
      ? buildRoomEventContext(
          buildResumableRoomContext(normalizedInboundUserContext),
          deliveryDirective,
        )
      : undefined;
    const currentInboundContextText = isRoomEvent
      ? buildRoomEventContext(normalizedInboundUserContext, deliveryDirective)
      : (inboundUserContextPromptJoiner === " "
          ? [deliveryDirective, normalizedInboundUserContext]
          : [normalizedInboundUserContext, deliveryDirective]
        )
          .filter(Boolean)
          .join("\n\n");
    const resetModelBody = isBareSessionReset
      ? [
          inboundUserContext,
          startupContextPrelude,
          baseBodyFinal,
          softResetTail
            ? `User note for this reset turn (treat as ordinary user input, not startup instructions):\n${softResetTail}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : baseBodyFinal;
    // Room-event turns and their transcript rows share one attributed chat line
    // so the active turn replays byte-identically as history; the room-event
    // marker and directive stay current-turn context only.
    const roomEventBody = isRoomEvent ? resolveRoomEventTranscriptBody() : undefined;
    const effectiveBaseBody =
      roomEventBody ?? (hasUserBody ? resetModelBody : MEDIA_ONLY_USER_TEXT);
    const transcriptBody = isHeartbeat
      ? resolveInternalTurnTranscript({
          InputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance,
          InternalTurnSource: ctx.InternalTurnSource ?? sessionCtx.InternalTurnSource,
        }).text
      : isBareSessionReset
        ? softResetTail || `[OpenClaw session ${startupAction}]`
        : effectiveBaseBody;
    const fragments: RuntimeContextFragment[] = [
      ...(isRoomEvent ? [{ kind: "runtime-instruction" as const, text: ROOM_EVENT_PROMPT }] : []),
      ...(normalizedInboundUserContext
        ? [{ kind: "conversation-data" as const, text: normalizedInboundUserContext }]
        : []),
      ...(deliveryDirective
        ? [{ kind: "runtime-instruction" as const, text: deliveryDirective }]
        : []),
    ];
    let currentInboundContext: CurrentInboundPromptContext | undefined =
      !isBareSessionReset && currentInboundContextText
        ? {
            text: currentInboundContextText,
            fragments,
            ...(resumableRoomEventContext ? { resumableText: resumableRoomEventContext } : {}),
            promptJoiner: inboundUserContextPromptJoiner,
            ...(activeGoalContext ? { injectedGoalContexts: [activeGoalContext] } : {}),
          }
        : undefined;
    if (requestGitCredit) {
      currentInboundContext = appendCurrentInboundContext(currentInboundContext, [
        { kind: "runtime-instruction", text: requestGitCredit },
      ]);
    }

    return {
      effectiveBaseBody,
      transcriptBody,
      currentInboundContext,
    };
  };

  const buildPromptBodies = (additions: {
    prefixedBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
    /** Facts whose model-facing projection is already present in the supplied body. */
    media?: readonly MediaFact[];
  }) => {
    const base = buildReplyPromptEnvelopeBase();
    const generatedMedia = buildInboundMediaNoteProjection(ctx);
    const mediaNote = generatedMedia.text;
    const media = [...generatedMedia.media, ...normalizeMediaFacts(additions.media)];
    const prependMediaNote = (body: string): string =>
      mediaNote ? [mediaNote, body].filter(Boolean).join("\n").trim() : body;
    const sourceContext: RuntimeContextFragment[] = [
      additions.threadContextNote,
      ...(additions.systemEventBlocks ?? []),
      appendChannelPromptContext("", sessionCtx.ChannelPromptContext),
    ]
      .filter((text): text is string => Boolean(text?.trim()))
      .map((text) => ({ kind: "conversation-data", text }));
    // Close thread context without overriding room events' optional-response policy.
    if (additions.threadContextNote?.trim() && inboundEventKind !== "room_event") {
      sourceContext.push({ kind: "runtime-instruction", text: CURRENT_MESSAGE_MARKER });
    }
    const annotateBody = (body: string) =>
      annotateInterSessionPromptText(prependMediaNote(body), sessionCtx.InputProvenance);
    return {
      inboundMediaIndexes: generatedMedia.mediaIndexes,
      ...(media.length > 0 ? { media } : {}),
      prefixedCommandBody: annotateBody(additions.prefixedBody ?? base.effectiveBaseBody),
      queuedBody: annotateBody(base.effectiveBaseBody),
      transcriptCommandBody:
        inboundEventKind === "room_event"
          ? base.transcriptBody
          : prependMediaNote(base.transcriptBody),
      transcriptBody: base.transcriptBody,
      currentInboundContext: sourceContext.length
        ? appendCurrentInboundContext(base.currentInboundContext, sourceContext)
        : base.currentInboundContext,
    };
  };

  const promptEnvelopeBase = buildReplyPromptEnvelopeBase();
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
    buildPromptBodies,
    refreshInboundContextAfterAdmissionWait,
    terminalReplyExpectation,
  } as const;
}

export type PreparedReplyRunContext = Extract<
  Awaited<ReturnType<typeof prepareReplyRunContext>>,
  { kind: "ready" }
>;
