// Main auto-reply pipeline: prepares context, runs commands, and dispatches agents.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, getRuntimeConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import { getMediaDir } from "../../media/store.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../heartbeat.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  type ReplyPayload,
} from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  initFastReplySessionState,
  buildFastReplyCommandContext,
  shouldHandleFastReplyTextCommands,
  shouldUseReplyFastDirectiveExecution,
  resolveGetReplyConfig,
  shouldUseReplyFastTestBootstrap,
  shouldUseReplyFastTestRuntime,
} from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { runPreparedReply } from "./get-reply-run.js";
import type {
  InternalGetReplyOptions as BaseInternalGetReplyOptions,
  ReplySessionBinding,
} from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { hasInboundMedia, hasInboundMediaForUnderstanding } from "./inbound-media.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createFastTestModelSelectionState, createModelSelectionState } from "./model-selection.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  replyRunRegistry,
  type ReplyOperation,
  withReplyRunAdmissionBlock,
} from "./reply-run-registry.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";
import { initSessionState } from "./session.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";
import {
  isStaleHeartbeatAutoFallbackOverride,
  resolveStoredModelOverride,
} from "./stored-model-override.js";
import { createTypingController } from "./typing.js";

type ResetCommandAction = "new" | "reset";

type RuntimeInternalGetReplyOptions = BaseInternalGetReplyOptions & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  extractedFileImages?: ExtractedFileImage[];
  replyOperation?: ReplyOperation;
};

type SandboxMediaRestageSource = {
  source: string;
  mediaType?: string;
};

function classifyHeartbeatPendingFinalDelivery(text: string, ackMaxChars: number) {
  const stripped = stripHeartbeatToken(text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  return {
    shouldClear: stripped.shouldSkip,
    replayText: stripped.didStrip && stripped.text ? stripped.text : text,
  };
}

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, agentId: string): number {
  const agentHeartbeat = resolveAgentConfig(cfg, agentId)?.heartbeat;
  return Math.max(
    0,
    agentHeartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

const sessionResetModelRuntimeLoader = createLazyImportLoader(
  () => import("./session-reset-model.runtime.js"),
);
const stageSandboxMediaRuntimeLoader = createLazyImportLoader(
  () => import("./stage-sandbox-media.runtime.js"),
);
const mediaUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../media-understanding/apply.runtime.js"),
);
const linkUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../link-understanding/apply.runtime.js"),
);

const replyResolverTimingLog = createSubsystemLogger("auto-reply/reply-resolver-timing");
const commandsCoreRuntimeLoader = createLazyImportLoader(
  () => import("./commands-core.runtime.js"),
);

function loadSessionResetModelRuntime() {
  return sessionResetModelRuntimeLoader.load();
}

function loadStageSandboxMediaRuntime() {
  return stageSandboxMediaRuntimeLoader.load();
}

function loadMediaUnderstandingApplyRuntime() {
  return mediaUnderstandingApplyRuntimeLoader.load();
}

function loadLinkUnderstandingApplyRuntime() {
  return linkUnderstandingApplyRuntimeLoader.load();
}

function loadCommandsCoreRuntime() {
  return commandsCoreRuntimeLoader.load();
}

const hookRunnerGlobalLoader = createLazyImportLoader(
  () => import("../../plugins/hook-runner-global.js"),
);
const originRoutingLoader = createLazyImportLoader(() => import("./origin-routing.js"));

function loadHookRunnerGlobal() {
  return hookRunnerGlobalLoader.load();
}

function loadOriginRouting() {
  return originRoutingLoader.load();
}

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
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
}): Promise<ApplyMediaUnderstandingResult | undefined> {
  if (!hasInboundMediaForUnderstanding(params.ctx)) {
    return undefined;
  }
  try {
    const { applyMediaUnderstanding } = await loadMediaUnderstandingApplyRuntime();
    return await applyMediaUnderstanding(params);
  } catch (err) {
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

function withExtractedFileImages(
  opts: RuntimeInternalGetReplyOptions | undefined,
  extractedFileImages: ExtractedFileImage[] | undefined,
): RuntimeInternalGetReplyOptions | undefined {
  if (!extractedFileImages || extractedFileImages.length === 0) {
    return opts;
  }
  return {
    ...opts,
    extractedFileImages: [...(opts?.extractedFileImages ?? []), ...extractedFileImages],
  };
}

function toInboundMediaUriForRestage(value: string | undefined): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return value;
  }
  const match = /^media\/inbound\/([^/\\]+)$/i.exec(raw.replace(/\\/g, "/"));
  return match ? `media://inbound/${encodeURIComponent(match[1])}` : raw;
}

type RemoteInboundMediaSourceSnapshot = Pick<
  MsgContext,
  "MediaPath" | "MediaPaths" | "MediaUrl" | "MediaUrls"
>;

function captureRemoteInboundMediaSourceSnapshot(
  ctx: MsgContext,
): RemoteInboundMediaSourceSnapshot | undefined {
  if (!normalizeOptionalString(ctx.MediaRemoteHost) || !hasInboundMedia(ctx)) {
    return undefined;
  }
  return {
    ...(ctx.MediaPath !== undefined ? { MediaPath: ctx.MediaPath } : {}),
    ...(ctx.MediaPaths ? { MediaPaths: [...ctx.MediaPaths] } : {}),
    ...(ctx.MediaUrl !== undefined ? { MediaUrl: ctx.MediaUrl } : {}),
    ...(ctx.MediaUrls ? { MediaUrls: [...ctx.MediaUrls] } : {}),
  };
}

function restoreRemoteInboundMediaSourceSnapshot(params: {
  ctx: MsgContext;
  sessionCtx: MsgContext;
  source: RemoteInboundMediaSourceSnapshot;
}): void {
  const mediaPaths = params.source.MediaPaths ? [...params.source.MediaPaths] : undefined;
  const mediaUrls = params.source.MediaUrls ? [...params.source.MediaUrls] : undefined;
  params.ctx.MediaPath = params.source.MediaPath;
  params.sessionCtx.MediaPath = params.source.MediaPath;
  params.ctx.MediaPaths = mediaPaths;
  params.sessionCtx.MediaPaths = mediaPaths;
  params.ctx.MediaUrl = params.source.MediaUrl;
  params.sessionCtx.MediaUrl = params.source.MediaUrl;
  params.ctx.MediaUrls = mediaUrls;
  params.sessionCtx.MediaUrls = mediaUrls;
}

function collectSandboxMediaRestageSources(ctx: MsgContext): SandboxMediaRestageSource[] {
  const mediaPaths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths.map((value) => normalizeOptionalString(value)).filter(
        (value): value is string => Boolean(value),
      )
    : [];
  const mediaTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes.map((value) => normalizeOptionalString(value))
    : [];
  const sources =
    mediaPaths.length > 0
      ? mediaPaths.map((source, index) => ({
          source,
          mediaType: mediaTypes[index] ?? normalizeOptionalString(ctx.MediaType),
        }))
      : (() => {
          const mediaPath = normalizeOptionalString(ctx.MediaPath);
          return mediaPath
            ? [
                {
                  source: mediaPath,
                  mediaType: normalizeOptionalString(ctx.MediaType),
                },
              ]
            : [];
        })();
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.source)) {
      return false;
    }
    seen.add(source.source);
    return true;
  });
}

function isPdfRestageSource(source: SandboxMediaRestageSource): boolean {
  const mime = source.mediaType?.trim().toLowerCase();
  if (mime === "application/pdf" || mime?.endsWith("+pdf")) {
    return true;
  }
  return path.extname(source.source.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

function mediaRestageSourceKeys(source: string): string[] {
  if (!source.startsWith("file://")) {
    return [source];
  }
  try {
    return [source, fileURLToPath(source)];
  } catch {
    return [source];
  }
}

function resolveLocalRestageSourcePath(source: string): string | undefined {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(source) ? source : undefined;
}

function isManagedInboundPdfPassThroughSource(source: SandboxMediaRestageSource): boolean {
  if (!isPdfRestageSource(source)) {
    return false;
  }
  if (/^media:\/\/inbound\/[^/\\]+$/i.test(source.source)) {
    return true;
  }
  const filePath = resolveLocalRestageSourcePath(source.source);
  return Boolean(filePath && isPathInside(path.join(getMediaDir(), "inbound"), filePath));
}

function didRestageAllSandboxMediaSources(params: {
  sources: readonly SandboxMediaRestageSource[];
  staged: ReadonlyMap<string, string>;
}): boolean {
  return params.sources.every(
    (source) =>
      mediaRestageSourceKeys(source.source).some((key) => params.staged.has(key)) ||
      isManagedInboundPdfPassThroughSource(source),
  );
}

function preparePrestagedMediaForRestage(params: {
  ctx: MsgContext;
  sessionCtx: MsgContext;
  remoteSource?: RemoteInboundMediaSourceSnapshot;
}): boolean {
  if (params.ctx.MediaStaged !== true || !hasInboundMedia(params.ctx)) {
    return false;
  }
  if (params.remoteSource) {
    restoreRemoteInboundMediaSourceSnapshot({
      ctx: params.ctx,
      sessionCtx: params.sessionCtx,
      source: params.remoteSource,
    });
    params.ctx.MediaStaged = undefined;
    params.sessionCtx.MediaStaged = undefined;
    return true;
  }
  const rewriteList = (values: string[] | undefined): string[] | undefined =>
    values?.map((value) => toInboundMediaUriForRestage(value) ?? value);
  const mediaPaths = rewriteList(params.ctx.MediaPaths);
  const mediaUrls = rewriteList(params.ctx.MediaUrls);
  const mediaPath = mediaPaths?.[0] ?? toInboundMediaUriForRestage(params.ctx.MediaPath);
  const mediaUrl = mediaUrls?.[0] ?? toInboundMediaUriForRestage(params.ctx.MediaUrl);

  if (mediaPaths) {
    params.ctx.MediaPaths = mediaPaths;
    params.sessionCtx.MediaPaths = mediaPaths;
  }
  if (mediaPath !== undefined) {
    params.ctx.MediaPath = mediaPath;
    params.sessionCtx.MediaPath = mediaPath;
  }
  if (mediaUrls) {
    params.ctx.MediaUrls = mediaUrls;
    params.sessionCtx.MediaUrls = mediaUrls;
  }
  if (mediaUrl !== undefined) {
    params.ctx.MediaUrl = mediaUrl;
    params.sessionCtx.MediaUrl = mediaUrl;
  }
  params.ctx.MediaStaged = undefined;
  params.sessionCtx.MediaStaged = undefined;
  return true;
}

function hasSandboxStagedMedia(ctx: MsgContext): boolean {
  return Boolean(ctx.MediaStaged === true && normalizeOptionalString(ctx.MediaWorkspaceDir));
}

function isPrestagedMediaForDifferentSession(ctx: MsgContext, sessionId: string): boolean {
  if (!hasSandboxStagedMedia(ctx)) {
    return false;
  }
  const stagedSessionId = normalizeOptionalString(ctx.MediaStagedSessionId);
  return Boolean(stagedSessionId && stagedSessionId !== sessionId);
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  try {
    const { applyLinkUnderstanding } = await loadLinkUnderstandingApplyRuntime();
    await applyLinkUnderstanding(params);
    return true;
  } catch (err) {
    linkUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `link understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = resolveGetReplyConfig({
    getRuntimeConfig,
    isFastTestEnv,
    configOverride,
  });
  // Profiler spans stay inert unless diagnostics enable `profiler` or
  // `reply.profiler`, so normal replies do not pay per-stage Date.now/array
  // bookkeeping while we can still split resolver costs on demand.
  const resolverTiming = createReplyTimingTracker({ log: replyResolverTimingLog, config: cfg });
  const useFastTestBootstrap = resolverTiming.measureSync("reply.resolve_fast_test_bootstrap", () =>
    shouldUseReplyFastTestBootstrap({
      isFastTestEnv,
      configOverride,
    }),
  );
  const useFastTestRuntime = resolverTiming.measureSync("reply.resolve_fast_test_runtime", () =>
    shouldUseReplyFastTestRuntime({
      cfg,
      isFastTestEnv,
    }),
  );
  const finalized = resolverTiming.measureSync("reply.finalize_context", () =>
    finalizeInboundContext(ctx),
  );
  const { agentSessionKey, agentId } = resolverTiming.measureSync(
    "reply.resolve_agent_scope",
    () => {
      const targetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
      const resolvedAgentSessionKey = targetSessionKey || finalized.SessionKey;
      return {
        agentSessionKey: resolvedAgentSessionKey,
        agentId: resolveSessionAgentId({
          sessionKey: resolvedAgentSessionKey,
          config: cfg,
          fallbackAgentId: finalized.AgentId,
        }),
      };
    },
  );
  const traceAttributes = resolverTiming.measureSync("reply.resolve_trace_context", () => ({
    surface: normalizeOptionalString(finalized.Surface ?? finalized.Provider) ?? "unknown",
    hasSessionKey: Boolean(agentSessionKey),
    isHeartbeat: opts?.isHeartbeat === true,
    hasMedia: hasInboundMedia(finalized),
  }));
  const messageId = finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast;
  let resolverTimingSessionKey = agentSessionKey;
  const logResolverTiming = (outcome: string, reason?: string, error?: string) =>
    resolverTiming.logIfSlow({
      message: `reply resolver timings surface=${traceAttributes.surface} messageId=${
        messageId ?? "unknown"
      } sessionKey=${resolverTimingSessionKey ?? "unknown"} agentId=${agentId}`,
      outcome,
      reason,
      error,
      details: {
        surface: traceAttributes.surface,
        messageId,
        sessionKey: resolverTimingSessionKey,
        agentId,
      },
    });
  const traceGetReplyPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    resolverTiming.measure(name, () =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: cfg,
        attributes: traceAttributes,
      }),
    );
  const mergedSkillFilter = resolverTiming.measureSync("reply.resolve_skill_filter", () =>
    mergeSkillFilters(opts?.skillFilter, resolveAgentSkillsFilter(cfg, agentId)),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const internalResolvedOpts = resolvedOpts as RuntimeInternalGetReplyOptions | undefined;
  let extractedFileImages: ExtractedFileImage[] | undefined;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolverTiming.measureSync(
    "reply.resolve_default_model",
    () =>
      resolveDefaultModel({
        cfg,
        agentId,
      }),
  );
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      normalizeOptionalString(opts.heartbeatModelOverride) ??
      normalizeOptionalString(agentCfg?.heartbeat?.model) ??
      "";
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

  const { workspaceDirRaw, workspaceDirForNativeCommand, agentDir, timeoutMs } =
    resolverTiming.measureSync("reply.resolve_workspace_agent_dir", () => {
      const workspaceDirRawLocal =
        resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
      return {
        workspaceDirRaw: workspaceDirRawLocal,
        workspaceDirForNativeCommand: workspaceDirRawLocal,
        agentDir: resolveAgentDir(cfg, agentId),
        timeoutMs: resolveAgentTimeoutMs({
          cfg,
          overrideSeconds: opts?.timeoutOverrideSeconds,
        }),
      };
    });
  const typing = resolverTiming.measureSync("reply.create_typing_controller", () => {
    const configuredTypingSeconds =
      agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
    const typingIntervalSeconds =
      typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
    const controller = createTypingController({
      onReplyStart: opts?.onReplyStart,
      onCleanup: opts?.onTypingCleanup,
      typingIntervalSeconds,
      keepalive: opts?.typingKeepalive ?? true,
      silentToken: SILENT_REPLY_TOKEN,
      log: defaultRuntime.log,
    });
    opts?.onTypingController?.(controller);
    return controller;
  });

  const nativeSlashCommandFastReply = await traceGetReplyPhase(
    "reply.native_slash_command_fast_path",
    () =>
      maybeResolveNativeSlashCommandFastReply({
        ctx: finalized,
        cfg,
        agentId,
        agentDir,
        agentCfg,
        commandAuthorized: finalized.CommandAuthorized,
        defaultProvider,
        defaultModel,
        aliasIndex,
        provider,
        model,
        workspaceDir: workspaceDirForNativeCommand,
        typing,
        opts: resolvedOpts,
        skillFilter: mergedSkillFilter,
      }),
  );
  if (nativeSlashCommandFastReply.handled) {
    logResolverTiming("completed", "native_slash_command_fast_path");
    return nativeSlashCommandFastReply.reply;
  }

  const workspace = await traceGetReplyPhase("reply.ensure_workspace", async () =>
    useFastTestBootstrap
      ? (await fs.mkdir(workspaceDirRaw, { recursive: true }), { dir: workspaceDirRaw })
      : await ensureAgentWorkspace({
          dir: workspaceDirRaw,
          ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
          skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
        }),
  );
  const workspaceDir = workspace.dir;

  let mediaUnderstandingApplied = false;
  const applyFinalizedMediaUnderstanding = async (phase: string) => {
    const mediaResult = await traceGetReplyPhase(phase, () =>
      applyMediaUnderstandingIfNeeded({
        ctx: finalized,
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        activeModel: { provider, model },
      }),
    );
    if (mediaResult?.extractedFileImages.length) {
      extractedFileImages = mediaResult.extractedFileImages;
    }
    if (
      mediaResult &&
      (mediaResult.outputs.length > 0 ||
        mediaResult.appliedFile ||
        mediaResult.extractedFileImages.length > 0)
    ) {
      mediaUnderstandingApplied = true;
    }
    return mediaResult;
  };

  const remoteInboundMediaSourceSnapshot = captureRemoteInboundMediaSourceSnapshot(finalized);
  if (
    !isFastTestEnv &&
    normalizeOptionalString(finalized.MediaRemoteHost) &&
    hasInboundMedia(finalized)
  ) {
    await traceGetReplyPhase("reply.stage_remote_media_pre_understanding", () =>
      stageRemoteInboundMediaIfNeeded({
        ctx: finalized,
        cfg,
        sessionKey: agentSessionKey,
        workspaceDir,
      }),
    );
  }
  if (!isFastTestEnv && hasInboundMediaForUnderstanding(finalized)) {
    await applyFinalizedMediaUnderstanding("reply.apply_media_understanding");
  }
  if (!isFastTestEnv && hasLinkCandidate(finalized)) {
    await traceGetReplyPhase("reply.apply_link_understanding", () =>
      applyLinkUnderstandingIfNeeded({
        ctx: finalized,
        cfg,
      }),
    );
  }
  emitPreAgentMessageHooks({
    ctx: finalized,
    cfg,
    isFastTestEnv,
  });

  const commandAuthorized = finalized.CommandAuthorized;
  const sessionState = useFastTestBootstrap
    ? initFastReplySessionState({
        ctx: finalized,
        cfg,
        agentId,
        commandAuthorized,
        workspaceDir,
      })
    : await traceGetReplyPhase("reply.init_session_state", () =>
        initSessionState({
          ctx: finalized,
          cfg,
          commandAuthorized,
          requestedSessionId: internalResolvedOpts?.requestedSessionId,
          resumeRequestedSession: internalResolvedOpts?.resumeRequestedSession,
        }),
      );
  const {
    sessionCtx,
    sessionEntry,
    sessionEntryHandle,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
    deferredSandboxLifecycleCleanup,
  } = sessionState;
  let { abortedLastRun } = sessionState;
  const currentReplyOperation = internalResolvedOpts?.replyOperation;
  if (
    currentReplyOperation &&
    currentReplyOperation.result === null &&
    currentReplyOperation.phase === "queued" &&
    currentReplyOperation.key === sessionKey &&
    currentReplyOperation.sessionId !== sessionId
  ) {
    currentReplyOperation.updateSessionId(sessionId);
  }
  let pendingSandboxLifecycleCleanup = deferredSandboxLifecycleCleanup;
  let sandboxLifecycleCleanupRetryScheduled = false;
  const runDeferredSandboxLifecycleCleanupAfterIdle = async (): Promise<boolean> => {
    const cleanup = pendingSandboxLifecycleCleanup;
    if (!cleanup) {
      return true;
    }
    const scheduleSandboxLifecycleCleanupRetry = () => {
      if (sandboxLifecycleCleanupRetryScheduled) {
        return;
      }
      sandboxLifecycleCleanupRetryScheduled = true;
      void replyRunRegistry
        .waitForIdle(sessionKey)
        .then(async () => {
          sandboxLifecycleCleanupRetryScheduled = false;
          await runDeferredSandboxLifecycleCleanupAfterIdle();
        })
        .catch((error: unknown) =>
          logVerbose(`sandbox lifecycle cleanup retry failed: ${String(error)}`),
        );
    };
    const activeOperation = replyRunRegistry.get(sessionKey);
    if (activeOperation && activeOperation !== currentReplyOperation) {
      if (
        previousSessionEntry?.sessionId &&
        activeOperation.sessionId === previousSessionEntry.sessionId
      ) {
        activeOperation.abortForRestart();
      }
      const idle = await replyRunRegistry.waitForIdle(sessionKey, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      if (!idle) {
        logVerbose(`sandbox lifecycle cleanup skipped; reply run still active for ${sessionKey}`);
        scheduleSandboxLifecycleCleanupRetry();
        return false;
      }
    }
    pendingSandboxLifecycleCleanup = undefined;
    try {
      await withReplyRunAdmissionBlock(
        sessionKey,
        async () => {
          await cleanup();
        },
        { currentOperation: currentReplyOperation },
      );
    } catch (error) {
      if (error instanceof ReplyRunAlreadyActiveError) {
        pendingSandboxLifecycleCleanup = cleanup;
        logVerbose(`sandbox lifecycle cleanup skipped; reply run still active for ${sessionKey}`);
        scheduleSandboxLifecycleCleanupRetry();
        return false;
      }
      logVerbose(`sandbox lifecycle cleanup failed before replacement turn: ${String(error)}`);
      return false;
    }
    return true;
  };
  resolverTimingSessionKey = sessionKey ?? resolverTimingSessionKey;
  internalResolvedOpts?.onSessionPrepared?.({
    sessionKey,
    sessionId,
    storePath,
  });

  const hasDeferredSandboxLifecycleCleanup = Boolean(deferredSandboxLifecycleCleanup);
  const sandboxLifecycleReady = await runDeferredSandboxLifecycleCleanupAfterIdle();
  if (!sandboxLifecycleReady) {
    typing.cleanup();
    logResolverTiming("completed", "sandbox_lifecycle_cleanup_pending");
    return markReplyPayloadForSourceSuppressionDelivery({
      text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
    });
  }
  const prestagedMediaSessionChanged = isPrestagedMediaForDifferentSession(finalized, sessionId);
  if (
    hasSandboxStagedMedia(finalized) &&
    (hasDeferredSandboxLifecycleCleanup || prestagedMediaSessionChanged) &&
    preparePrestagedMediaForRestage({
      ctx: finalized,
      sessionCtx,
      remoteSource: remoteInboundMediaSourceSnapshot,
    })
  ) {
    const restageSources = collectSandboxMediaRestageSources(finalized);
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    const restageResult = await traceGetReplyPhase(
      "reply.restage_media_after_sandbox_cleanup",
      () =>
        stageSandboxMedia({
          ctx: finalized,
          sessionCtx,
          cfg,
          sessionKey,
          workspaceDir,
        }),
    );
    if (
      !didRestageAllSandboxMediaSources({
        sources: restageSources,
        staged: restageResult.staged,
      })
    ) {
      typing.cleanup();
      logVerbose("sandbox lifecycle media restage incomplete after replacement cleanup");
      logResolverTiming("completed", "sandbox_lifecycle_media_restaging_failed");
      return markReplyPayloadForSourceSuppressionDelivery({
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      });
    }
    finalized.MediaStaged = true;
    finalized.MediaStagedSessionId = sessionId;
    sessionCtx.MediaStaged = true;
    sessionCtx.MediaStagedSessionId = sessionId;
    ctx.MediaPath = finalized.MediaPath;
    ctx.MediaPaths = finalized.MediaPaths ? [...finalized.MediaPaths] : undefined;
    ctx.MediaUrl = finalized.MediaUrl;
    ctx.MediaUrls = finalized.MediaUrls ? [...finalized.MediaUrls] : undefined;
    ctx.MediaStaged = true;
    ctx.MediaStagedSessionId = sessionId;
    if (
      prestagedMediaSessionChanged &&
      !mediaUnderstandingApplied &&
      !isFastTestEnv &&
      hasInboundMediaForUnderstanding(finalized)
    ) {
      await applyFinalizedMediaUnderstanding("reply.apply_media_understanding_after_restaging");
    }
  }

  if (sessionEntry?.pendingFinalDelivery && sessionEntry.pendingFinalDeliveryText) {
    const text = sanitizePendingFinalDeliveryText(sessionEntry.pendingFinalDeliveryText);

    // Heartbeats may safely clear ack-only pending state, but must not replay
    // user-facing pending finals through a different delivery target.
    if (opts?.isHeartbeat) {
      const heartbeatPending = classifyHeartbeatPendingFinalDelivery(
        text,
        resolveHeartbeatAckMaxChars(cfg, agentId),
      );
      if (heartbeatPending.shouldClear) {
        sessionEntry.pendingFinalDelivery = undefined;
        sessionEntry.pendingFinalDeliveryText = undefined;
        sessionEntry.pendingFinalDeliveryCreatedAt = undefined;
        sessionEntry.pendingFinalDeliveryLastAttemptAt = undefined;
        sessionEntry.pendingFinalDeliveryAttemptCount = undefined;
        sessionEntry.pendingFinalDeliveryLastError = undefined;
        sessionEntry.pendingFinalDeliveryContext = undefined;
        sessionEntryHandle.replaceCurrent(sessionEntry);
        if (sessionKey && sessionStore) {
          sessionStore[sessionKey] = sessionEntry;
        }
        if (sessionKey && storePath) {
          const { updateSessionEntry } = await import("../../config/sessions/session-accessor.js");
          await updateSessionEntry(
            { storePath, sessionKey },
            () => ({
              pendingFinalDelivery: undefined,
              pendingFinalDeliveryText: undefined,
              pendingFinalDeliveryCreatedAt: undefined,
              pendingFinalDeliveryLastAttemptAt: undefined,
              pendingFinalDeliveryAttemptCount: undefined,
              pendingFinalDeliveryLastError: undefined,
              pendingFinalDeliveryContext: undefined,
            }),
            {
              skipMaintenance: true,
              takeCacheOwnership: true,
            },
          );
        }
      }
    }
  }

  if (resetTriggered && normalizeOptionalString(bodyStripped)) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    await applyResetModelOverride({
      cfg,
      agentId,
      resetTriggered,
      bodyStripped,
      sessionCtx,
      ctx: finalized,
      sessionEntry,
      sessionEntryHandle,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      aliasIndex,
    });
  }

  const channelModelOverride = cfg.channels?.modelByChannel
    ? resolveChannelModelOverride({
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
        groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
        groupChannel:
          sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
        groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
        parentSessionKey: sessionCtx.ModelParentSessionKey ?? sessionCtx.ParentSessionKey,
        directUserIds: [
          sessionEntry.origin?.nativeDirectUserId,
          sessionEntry.origin?.from,
          sessionEntry.origin?.to,
          finalized.OriginatingTo,
          finalized.From,
          finalized.SenderId,
        ],
      })
    : null;
  const resolvedChannelModelOverride =
    channelModelOverride && !hasResolvedHeartbeatModelOverride
      ? resolveModelRefFromString({
          raw: channelModelOverride.model,
          defaultProvider,
          aliasIndex,
        })
      : null;
  const primaryProvider = resolvedChannelModelOverride?.ref.provider ?? defaultProvider;
  const primaryModel = resolvedChannelModelOverride?.ref.model ?? defaultModel;
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  const storedModelOverride = resolveStoredModelOverride({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey:
      sessionEntry.parentSessionKey ??
      sessionCtx.ModelParentSessionKey ??
      sessionCtx.ParentSessionKey,
    defaultProvider,
  });
  const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
    isHeartbeat: opts?.isHeartbeat === true,
    hasResolvedHeartbeatModelOverride,
    sessionEntry,
    storedOverride: storedModelOverride,
    defaultProvider,
    defaultModel,
    primaryProvider,
    primaryModel,
  });
  const staleLegacyAutoFallbackWithoutOrigin =
    storedModelOverride?.source === "session" && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  if (
    storedModelOverride?.model &&
    !hasResolvedHeartbeatModelOverride &&
    !staleHeartbeatAutoFallbackOverride &&
    !staleLegacyAutoFallbackWithoutOrigin
  ) {
    provider = storedModelOverride.provider ?? defaultProvider;
    model = storedModelOverride.model;
  }
  const canApplyAutoFallbackPrimaryProbe =
    !hasResolvedHeartbeatModelOverride && !staleHeartbeatAutoFallbackOverride;
  const autoFallbackPrimaryProbe = canApplyAutoFallbackPrimaryProbe
    ? resolveAutoFallbackPrimaryProbe({
        entry: sessionEntry,
        sessionKey,
        primaryProvider,
        primaryModel,
      })
    : undefined;
  const hasEffectiveSessionModelOverride =
    hasSessionModelOverride &&
    !staleHeartbeatAutoFallbackOverride &&
    !staleLegacyAutoFallbackWithoutOrigin;
  if (
    !hasResolvedHeartbeatModelOverride &&
    !hasEffectiveSessionModelOverride &&
    resolvedChannelModelOverride
  ) {
    provider = resolvedChannelModelOverride.ref.provider;
    model = resolvedChannelModelOverride.ref.model;
  }

  if (
    shouldUseReplyFastDirectiveExecution({
      isFastTestBootstrap: useFastTestRuntime,
      isGroup,
      isHeartbeat: opts?.isHeartbeat === true,
      resetTriggered,
      triggerBodyNormalized,
    })
  ) {
    const fastCommand = buildFastReplyCommandContext({
      ctx,
      cfg,
      agentId,
      sessionKey,
      isGroup,
      triggerBodyNormalized,
      commandAuthorized,
    });
    logResolverTiming("milestone", "before_fast_directive_prepared_reply");
    const fastReplyResult = await traceGetReplyPhase("reply.run_prepared_reply", async () => {
      try {
        return await runPreparedReply({
          ctx,
          sessionCtx,
          cfg,
          agentId,
          agentDir,
          agentCfg,
          sessionCfg,
          commandAuthorized,
          command: fastCommand,
          commandSource:
            finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
          allowTextCommands: shouldHandleFastReplyTextCommands({
            cfg,
            commandSource: finalized.CommandSource,
          }),
          directives: clearInlineDirectives(
            finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
          ),
          defaultActivation: "always",
          resolvedThinkLevel: undefined,
          resolvedVerboseLevel: normalizeVerboseLevel(agentCfg?.verboseDefault),
          resolvedReasoningLevel: "off",
          resolvedElevatedLevel: "off",
          execOverrides: undefined,
          elevatedEnabled: false,
          elevatedAllowed: false,
          blockStreamingEnabled: false,
          blockReplyChunking: undefined,
          resolvedBlockStreamingBreak: "text_end",
          modelState: createFastTestModelSelectionState({
            agentCfg,
            provider: autoFallbackPrimaryProbe?.provider ?? provider,
            model: autoFallbackPrimaryProbe?.model ?? model,
          }),
          provider: autoFallbackPrimaryProbe?.provider ?? provider,
          model: autoFallbackPrimaryProbe?.model ?? model,
          perMessageQueueMode: undefined,
          perMessageQueueOptions: undefined,
          typing,
          opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
          defaultModel,
          timeoutMs,
          isNewSession,
          resetTriggered,
          systemSent,
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          sessionId,
          storePath,
          workspaceDir,
          abortedLastRun,
          autoFallbackPrimaryProbe,
          deferredSandboxLifecycleCleanup: async () => {
            await runDeferredSandboxLifecycleCleanupAfterIdle();
          },
        });
      } finally {
        await runDeferredSandboxLifecycleCleanupAfterIdle();
      }
    });
    logResolverTiming("completed", "fast_directive_prepared_reply");
    return fastReplyResult;
  }

  const directiveResult = await traceGetReplyPhase("reply.resolve_directives", () =>
    resolveReplyDirectives({
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
      resetTriggered,
      commandAuthorized,
      defaultProvider,
      defaultModel,
      primaryProvider,
      primaryModel,
      aliasIndex,
      provider,
      model,
      hasResolvedHeartbeatModelOverride,
      typing,
      opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
      skillFilter: mergedSkillFilter,
    }),
  );
  if (directiveResult.kind === "reply") {
    await runDeferredSandboxLifecycleCleanupAfterIdle();
    logResolverTiming("completed", "directive_reply");
    return directiveResult.reply;
  }
  const {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedFastMode,
    resolvedFastModeAutoOnSeconds,
    resolvedFastModeOverride,
    resolvedFastModeAutoOnSecondsOverride,
    resolvedVerboseLevel,
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
  let { directives, cleanedBody, resolvedThinkLevel, resolvedReasoningLevel } =
    directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await loadCommandsCoreRuntime();
    const action: ResetCommandAction = resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
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

  const inlineActionResult = await traceGetReplyPhase("reply.handle_inline_actions", () =>
    handleInlineActions({
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
      opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
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
    }),
  );
  if (inlineActionResult.kind === "reply") {
    await runDeferredSandboxLifecycleCleanupAfterIdle();
    await maybeEmitMissingResetHooks();
    logResolverTiming("completed", "inline_action_reply");
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  cleanedBody = inlineActionResult.cleanedBody;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;
  const runAutoFallbackPrimaryProbe = directives.hasModelDirective
    ? undefined
    : autoFallbackPrimaryProbe;
  const runProvider = runAutoFallbackPrimaryProbe?.provider ?? provider;
  const runModel = runAutoFallbackPrimaryProbe?.model ?? model;
  let runModelState = modelState;
  if (runAutoFallbackPrimaryProbe) {
    runModelState = await createModelSelectionState({
      cfg,
      agentId,
      agentCfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey:
        sessionEntry.parentSessionKey ??
        sessionCtx.ModelParentSessionKey ??
        sessionCtx.ParentSessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      primaryProvider,
      primaryModel,
      provider: runProvider,
      model: runModel,
      hasModelDirective: false,
      skipStoredModelOverride: true,
      hasResolvedHeartbeatModelOverride,
      isHeartbeat: opts?.isHeartbeat === true,
    });
    const hasExplicitThinkLevel =
      resolvedOpts?.thinkingLevelOverride !== undefined ||
      directives.thinkLevel !== undefined ||
      (!directives.clearThinkLevel && sessionEntry.thinkingLevel !== undefined) ||
      agentCfg?.thinkingDefault !== undefined;
    if (!hasExplicitThinkLevel) {
      resolvedThinkLevel = await runModelState.resolveDefaultThinkingLevel();
    }
    const agentEntry = resolveAgentConfig(cfg, agentId);
    const rawSessionReasoningLevel = sessionEntry.reasoningLevel;
    const canUseReasoningState =
      command.isAuthorizedSender ||
      command.senderIsOwner ||
      (Array.isArray(ctx.GatewayClientScopes) &&
        ctx.GatewayClientScopes.includes("operator.admin"));
    const hasExplicitReasoningLevel =
      directives.reasoningLevel !== undefined ||
      (rawSessionReasoningLevel != null && canUseReasoningState) ||
      (rawSessionReasoningLevel != null && !canUseReasoningState) ||
      agentEntry?.reasoningDefault != null ||
      agentCfg?.reasoningDefault != null;
    if (!hasExplicitReasoningLevel && resolvedThinkLevel === "off") {
      resolvedReasoningLevel = await runModelState.resolveDefaultReasoningLevel();
    }
  }

  // Allow plugins to intercept and return a synthetic reply before the LLM runs.
  if (!useFastTestBootstrap) {
    const { getGlobalHookRunner } = await loadHookRunnerGlobal();
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_agent_reply")) {
      const { resolveOriginMessageProvider } = await loadOriginRouting();
      const hookMessageProvider = resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider,
      });
      const hookChatId =
        normalizeOptionalString(sessionCtx.NativeChannelId) ??
        normalizeOptionalString(sessionCtx.ChatId);
      const hookTrigger = opts?.isHeartbeat ? "heartbeat" : "user";
      const hookResult = await traceGetReplyPhase("reply.before_agent_reply_hooks", () =>
        hookRunner.runBeforeAgentReply(
          { cleanedBody },
          {
            agentId,
            sessionKey: agentSessionKey,
            sessionId,
            workspaceDir,
            trigger: hookTrigger,
            ...buildAgentHookContextChannelFields({
              sessionKey: agentSessionKey,
              messageProvider: hookMessageProvider,
              currentChannelId: sessionCtx.OriginatingTo ?? ctx.OriginatingTo ?? ctx.To,
              messageTo: sessionCtx.OriginatingTo ?? ctx.OriginatingTo ?? ctx.To,
              senderId: sessionCtx.SenderId ?? ctx.SenderId,
            }),
            ...buildAgentHookContextIdentityFields({
              trigger: hookTrigger,
              senderId: sessionCtx.SenderId,
              chatId: hookChatId,
              channelContext: sessionCtx.ChannelContext ?? ctx.ChannelContext,
            }),
          },
        ),
      );
      if (hookResult?.handled) {
        await runDeferredSandboxLifecycleCleanupAfterIdle();
        logResolverTiming("completed", "before_agent_reply_hook");
        return hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
      }
    }
  }

  // ctx.MediaStaged=true means the caller (e.g. chat.send RPC) already staged
  // synchronously so it could surface 5xx before respond(). Skipping here keeps
  // staging a single-call contract instead of relying on relative-path no-op
  // semantics in stageSandboxMedia.
  if (!useFastTestBootstrap && sessionKey && !ctx.MediaStaged && hasInboundMedia(ctx)) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    await traceGetReplyPhase("reply.stage_media", () =>
      stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      }),
    );
  }

  logResolverTiming("milestone", "before_run_prepared_reply");
  const replyResult = await traceGetReplyPhase("reply.run_prepared_reply", async () => {
    try {
      return await runPreparedReply({
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
        resolvedFastMode,
        resolvedFastModeAutoOnSeconds,
        resolvedFastModeOverride,
        resolvedFastModeAutoOnSecondsOverride,
        resolvedVerboseLevel,
        resolvedReasoningLevel,
        resolvedElevatedLevel,
        execOverrides,
        elevatedEnabled,
        elevatedAllowed,
        blockStreamingEnabled,
        blockReplyChunking,
        resolvedBlockStreamingBreak,
        modelState: runModelState,
        provider: runProvider,
        model: runModel,
        perMessageQueueMode,
        perMessageQueueOptions,
        typing,
        opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
        defaultModel,
        timeoutMs,
        isNewSession,
        resetTriggered,
        systemSent,
        sessionEntry,
        sessionEntryHandle,
        sessionStore,
        sessionKey,
        sessionId,
        storePath,
        workspaceDir,
        abortedLastRun,
        autoFallbackPrimaryProbe: runAutoFallbackPrimaryProbe,
        deferredSandboxLifecycleCleanup: async () => {
          await runDeferredSandboxLifecycleCleanupAfterIdle();
        },
      });
    } finally {
      await runDeferredSandboxLifecycleCleanupAfterIdle();
    }
  });
  logResolverTiming("completed", "prepared_reply");
  return replyResult;
}
