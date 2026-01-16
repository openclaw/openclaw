import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { type ClawdbotConfig, loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { hasAudioTranscriptionConfig, transcribeInboundAudio } from "../transcription.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import {
  normalizeMediaUnderstandingChatType,
  resolveMediaUnderstandingScope,
} from "../../media-understanding/scope.js";
import { resolveAudioAttachment } from "./attachments.js";
import { extractMediaUserText, formatMediaUnderstandingBody } from "../../media-understanding/format.js";

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: ClawdbotConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const cfg = configOverride ?? loadConfig();
  const agentId = resolveSessionAgentId({
    sessionKey: ctx.SessionKey,
    config: cfg,
  });
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  if (opts?.isHeartbeat) {
    const heartbeatRaw = agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const mediaUnderstanding = await applyMediaUnderstanding({
    ctx,
    cfg,
    agentDir,
  });

  const audioAttachment = resolveAudioAttachment(ctx);
  const audioScopeDecision = resolveMediaUnderstandingScope({
    scope: cfg.tools?.audio?.transcription?.scope,
    sessionKey: ctx.SessionKey,
    channel: ctx.Surface ?? ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(ctx.ChatType),
  });
  let transcribedText: string | undefined;
  if (
    hasAudioTranscriptionConfig(cfg) &&
    audioAttachment &&
    !mediaUnderstanding.appliedAudio &&
    audioScopeDecision !== "deny"
  ) {
    const priorUserText = extractMediaUserText(ctx.CommandBody ?? ctx.RawBody);
    const transcriptionCtx: MsgContext = {
      ...ctx,
      MediaPath: audioAttachment.path ?? ctx.MediaPath,
      MediaUrl: audioAttachment.url ?? ctx.MediaUrl,
      MediaType: audioAttachment.type ?? ctx.MediaType,
    };
    const transcribed = await transcribeInboundAudio(cfg, transcriptionCtx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Transcript = transcribed.text;
      ctx.CommandBody = transcribed.text;
      ctx.RawBody = transcribed.text;
      if (mediaUnderstanding.appliedVideo || (ctx.MediaUnderstanding?.length ?? 0) > 0) {
        const mergedOutputs = [
          ...(ctx.MediaUnderstanding ?? []),
          {
            kind: "audio.transcription",
            attachmentIndex: audioAttachment.index,
            text: transcribed.text,
            provider: "cli",
          },
        ].sort((a, b) => a.attachmentIndex - b.attachmentIndex);
        ctx.MediaUnderstanding = mergedOutputs;
        ctx.Body = formatMediaUnderstandingBody({
          body: priorUserText ?? undefined,
          outputs: mergedOutputs,
        });
      } else {
        ctx.Body = transcribed.text;
        logVerbose("Replaced Body with audio transcript for reply flow");
      }
    }
  } else if (
    audioScopeDecision === "deny" &&
    hasAudioTranscriptionConfig(cfg) &&
    audioAttachment &&
    !mediaUnderstanding.appliedAudio
  ) {
    logVerbose("Audio transcription disabled by scope policy.");
  }

  const commandAuthorized = ctx.CommandAuthorized ?? true;
  resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
  } = sessionState;

  const directiveResult = await resolveReplyDirectives({
    ctx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    typing,
    opts,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
  });
  if (inlineActionResult.kind === "reply") {
    return inlineActionResult.reply;
  }
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    sessionKey,
    workspaceDir,
  });

  return runPreparedReply({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    transcribedText,
    typing,
    opts,
    defaultModel,
    timeoutMs,
    isNewSession,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
  });
}
