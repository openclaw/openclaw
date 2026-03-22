import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

function shouldLogCoreIngressTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

type ResetCommandAction = "new" | "reset";

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return normalizeStringEntries(list);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function hasInboundMedia(ctx: MsgContext): boolean {
  return Boolean(
    ctx.StickerMediaIncluded ||
    ctx.Sticker ||
    ctx.MediaPath?.trim() ||
    ctx.MediaUrl?.trim() ||
    ctx.MediaPaths?.some((value) => value?.trim()) ||
    ctx.MediaUrls?.some((value) => value?.trim()) ||
    ctx.MediaTypes?.length,
  );
}

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel: { provider: string; model: string };
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  const { applyMediaUnderstanding } = await import("../../media-understanding/apply.runtime.js");
  await applyMediaUnderstanding(params);
  return true;
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  const { applyLinkUnderstanding } = await import("../../link-understanding/apply.runtime.js");
  await applyLinkUnderstanding(params);
  return true;
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const ingressTimingEnabled = shouldLogCoreIngressTiming();
  const ingressStartMs = ingressTimingEnabled ? Date.now() : 0;
  const logIngressStage = (stage: string, extra?: string) => {
    if (!ingressTimingEnabled) {
      return;
    }
    const sessionKey = ctx.SessionKey?.trim() || "(no-session)";
    const suffix = extra ? ` ${extra}` : "";
    defaultRuntime.log?.(
      `[ingress] session=${sessionKey} stage=${stage} elapsedMs=${Date.now() - ingressStartMs}${suffix}`,
    );
  };
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = configOverride ?? loadConfig();
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  // Handle modelOverride from Gateway (e.g., image model when images detected)
  let hasAppliedImageModelOverride = false;
  // Save original provider/model for media understanding (before image model override)
  const originalProvider = provider;
  const originalModel = model;
  if (opts?.modelOverride?.trim()) {
    const modelRef = resolveModelRefFromString({
      raw: opts.modelOverride.trim(),
      defaultProvider,
      aliasIndex,
    });
    if (modelRef) {
      // Check if the model is allowed by the agent's allowlist
      // Use buildAllowedModelSet to include models + fallbacks + default model
      const { allowAny, allowedKeys } = buildAllowedModelSet({
        cfg,
        catalog: [], // Empty catalog; we only need allowedKeys
        defaultProvider,
        defaultModel,
        agentId,
      });
      if (!allowAny) {
        const modelKeyStr = modelKey(modelRef.ref.provider, modelRef.ref.model);
        if (!allowedKeys.has(modelKeyStr)) {
          // Model not in allowlist, skip the override and let default model be used
          // This prevents Dashboard images from bypassing agent model restrictions
        } else {
          provider = modelRef.ref.provider;
          model = modelRef.ref.model;
          hasAppliedImageModelOverride = true;
        }
      } else {
        // No allowlist, allow any model
        provider = modelRef.ref.provider;
        model = modelRef.ref.model;
        hasAppliedImageModelOverride = true;
      }
    }
  } else if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
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
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;
  logIngressStage("workspace-ready");
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);

  if (!isFastTestEnv) {
    // Use original provider/model for media understanding check, not the image model override.
    // This ensures media understanding runs even if hooks later switch back to a non-vision model.
    const appliedMediaUnderstanding = await applyMediaUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider: originalProvider, model: originalModel },
    });
    logIngressStage("media-understanding", `applied=${appliedMediaUnderstanding ? "1" : "0"}`);
    const appliedLinkUnderstanding = await applyLinkUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
    });
    logIngressStage("link-understanding", `applied=${appliedLinkUnderstanding ? "1" : "0"}`);
  }
  emitPreAgentMessageHooks({
    ctx: finalized,
    cfg,
    isFastTestEnv,
  });

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorization({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  logIngressStage("session-init");
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  await applyResetModelOverride({
    cfg,
    agentId,
    resetTriggered,
    bodyStripped,
    sessionCtx,
    ctx: finalized,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    aliasIndex,
  });

  const channelModelOverride = resolveChannelModelOverride({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    sessionEntry.modelOverride?.trim() || sessionEntry.providerOverride?.trim(),
  );

  // Check if channel model is already a vision model (skip image model switch if so)
  let channelModelIsVisionModel = false;
  if (channelModelOverride) {
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "" });

    // Resolve the channel model to get provider/model
    const channelResolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });

    if (channelResolved) {
      // First, check if the channel model matches the configured imageModel or its fallbacks
      const imageModelConfig = cfg.agents?.defaults?.imageModel;
      const imageModelPrimary = resolveAgentModelPrimaryValue(imageModelConfig);
      if (imageModelPrimary) {
        const imageModelKeys = new Set<string>();
        const addResolvedModelKey = (rawModel: string) => {
          imageModelKeys.add(rawModel.trim());
          const resolved = resolveModelRefFromString({
            raw: rawModel.trim(),
            defaultProvider: "",
            aliasIndex,
          });
          if (resolved) {
            imageModelKeys.add(modelKey(resolved.ref.provider, resolved.ref.model));
          }
        };
        addResolvedModelKey(imageModelPrimary);
        const fallbacks = resolveAgentModelFallbackValues(imageModelConfig);
        for (const fb of fallbacks) {
          if (fb?.trim()) {
            addResolvedModelKey(fb);
          }
        }
        const channelKey = modelKey(channelResolved.ref.provider, channelResolved.ref.model);
        if (imageModelKeys.has(channelKey) || imageModelKeys.has(channelModelOverride.model)) {
          channelModelIsVisionModel = true;
        }
      }

      // If not found in imageModel list, check catalog for vision capabilities
      if (!channelModelIsVisionModel) {
        try {
          const catalog = await loadModelCatalog({ config: cfg });
          const catalogEntry = findModelInCatalog(
            catalog,
            channelResolved.ref.provider,
            channelResolved.ref.model,
          );
          if (modelSupportsVision(catalogEntry)) {
            channelModelIsVisionModel = true;
          }
        } catch {
          // Catalog lookup failed; fall back to text-only assumption
        }
      }
    }
  }

  // Skip channel model override when image model was already selected for attachments,
  // UNLESS the channel model is already a vision model (no need to switch)
  if (
    !hasResolvedHeartbeatModelOverride &&
    !hasSessionModelOverride &&
    !(hasAppliedImageModelOverride && !channelModelIsVisionModel) &&
    channelModelOverride
  ) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
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
    hasResolvedHeartbeatModelOverride,
    hasAppliedImageModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
  });
  logIngressStage("directives-resolved");
  if (directiveResult.kind === "reply") {
    logIngressStage("early-reply");
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
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
    execOverrides,
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

  // Re-check if the final model matches the image model override.
  // If directives/stored override picked a different model, reset the flags
  // to avoid passing wrong auth profile and fallbacks.
  let finalHasAppliedImageModelOverride = hasAppliedImageModelOverride;
  // Only pass fallbacks if image model override was actually applied
  let finalModelOverrideFallbacks = hasAppliedImageModelOverride
    ? opts?.modelOverrideFallbacks
    : undefined;
  if (hasAppliedImageModelOverride && opts?.modelOverride) {
    const finalModelKey = modelKey(provider, model);
    const overrideRef = resolveModelRefFromString({
      raw: opts.modelOverride.trim(),
      defaultProvider,
      aliasIndex,
    });
    if (overrideRef) {
      const overrideKey = modelKey(overrideRef.ref.provider, overrideRef.ref.model);
      if (finalModelKey !== overrideKey) {
        // Final model differs from image model override, reset the flags
        finalHasAppliedImageModelOverride = false;
        finalModelOverrideFallbacks = undefined;
      }
    }
  }

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await import("./commands-core.runtime.js");
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      ctx,
      cfg,
      command,
      sessionKey,
      sessionEntry,
      previousSessionEntry,
      workspaceDir,
    });
  };

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
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
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    sessionKey,
    workspaceDir,
  });
  logIngressStage("sandbox-media");

  // Create final opts with potentially cleared modelOverrideFallbacks
  const finalOpts =
    finalModelOverrideFallbacks !== opts?.modelOverrideFallbacks
      ? { ...resolvedOpts, modelOverrideFallbacks: finalModelOverrideFallbacks }
      : resolvedOpts;

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
    execOverrides,
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
    typing,
    opts: finalOpts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
    hasAppliedImageModelOverride: finalHasAppliedImageModelOverride,
  });
}
