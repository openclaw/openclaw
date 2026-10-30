import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isImplicitAcpWorkspaceCandidate } from "../../agents/agent-scope-config.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  WorkspaceAliasRepointedError,
  WorkspaceVanishedError,
} from "../../agents/workspace-state-identity.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, getRuntimeConfig } from "../../config/config.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { resolveSessionModelOverrideSource } from "../../config/sessions/model-override-provenance.js";
import { logVerbose } from "../../globals.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import { hasStagedMediaFacts } from "../../media/media-facts.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  type ReplyPayload,
} from "../reply-payload.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { normalizeThinkLevel } from "../thinking.js";
import { finishCommandTurn } from "./command-turn-completion.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { resolveActiveExplicitSteerSessionKey } from "./explicit-steer-routing.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  initFastReplySessionState,
  resolveGetReplyConfig,
  shouldUseReplyFastTestRuntime,
} from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import {
  applyLinkUnderstandingIfNeeded,
  canReadReplyAttachmentPaths,
  applyMediaUnderstandingIfNeeded,
  hasExplicitAudioUnderstandingConfig,
  hasLinkCandidate,
  resolveReplyAgentScope,
} from "./get-reply-preprocessing.js";
import { runPreparedReply } from "./get-reply-run.js";
import {
  prepareInternalGetReplyOptions,
  withExtractedFileImages,
  type InternalGetReplyOptions,
} from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  hasInboundAudio,
  hasInboundMedia,
  hasInboundMediaForUnderstanding,
} from "./inbound-media.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createModelSelectionState, resolveTurnModelSelection } from "./model-selection.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { attachProgressNarratorToReplyOptions } from "./progress-narrator.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { createReplyProbeModelLevelResolver } from "./reply-model-levels.js";
import {
  recordReplyPreRunRejection,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";
import { prepareReplySourceInput, retireUnadoptedReplySource } from "./reply-source-binding.js";
import { createReplyTimingTracker, isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import { prepareReplyWorkspace } from "./reply-workspace.js";
import { withReplySessionDiffBaseline, type ReplyDiffBaseline } from "./session-diff-baseline.js";
import { resolveScheduledSessionModelSelection } from "./session-event-model-selection.js";
import { resolveReplySessionInitializationOptions } from "./session-initialization-admission.js";
import { SessionResetCleanupError } from "./session-reset-cleanup.js";
import { initSessionState, resolveReplySessionPreprocessingState } from "./session.js";
import { mergeSkillFilters } from "./skill-filter.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";
import { resolveReplyStoredModelSelection } from "./stored-model-override.js";
import { createTypingController } from "./typing.js";

const stageSandboxMediaRuntimeLoader = createLazyImportLoader(
  () => import("./stage-sandbox-media.js"),
);
const replyResolverTimingLog = createSubsystemLogger("auto-reply/reply-resolver-timing");

export async function getReplyFromConfig(
  ctx: MsgContext,
  options?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  return withReplySessionDiffBaseline((baseline) =>
    resolveReplyFromConfig(ctx, options, configOverride, baseline),
  );
}

async function resolveReplyFromConfig(
  ctx: MsgContext,
  options: InternalGetReplyOptions | undefined,
  configOverride: OpenClawConfig | undefined,
  baseline: ReplyDiffBaseline,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  let opts = prepareInternalGetReplyOptions(options, ctx);
  const isFastTestEnv = isFastTestRuntimeEnv();
  const preparedReplyDispatchRuntime = configOverride
    ? undefined
    : getPreparedReplyDispatchRuntime();
  const cfg =
    preparedReplyDispatchRuntime?.config ??
    resolveGetReplyConfig({
      getRuntimeConfig,
      isFastTestEnv,
      configOverride,
    });
  const source = await prepareReplySourceInput(ctx, cfg, opts);
  opts = source.options;
  try {
    // Retain preparation timings before a stall happens. Whole-turn summaries
    // include inference and tools, so only profiling warns on their duration.
    const profilerEnabled = isReplyProfilerEnabled({ config: cfg });
    const resolverTiming = createReplyTimingTracker({
      log: replyResolverTimingLog,
      enabled: profilerEnabled,
    });
    const useFastTestBootstrap = resolverTiming.measureSync(
      "reply.resolve_fast_test_bootstrap",
      () =>
        shouldUseReplyFastTestRuntime({
          isFastTestEnv,
          cfg: configOverride,
        }),
    );
    const inboundMediaWasAlreadyStaged = hasStagedMediaFacts(ctx.media);
    const finalized = resolverTiming.measureSync("reply.finalize_context", () =>
      finalizeInboundContext(ctx),
    );
    // Resolve legacy text-slash source lanes before any session-scoped work.
    // The explicit steer command itself still flows through normal command and
    // prepared-reply handling; this only gives that path the active owner's key.
    const explicitSteerTargetSessionKey = resolverTiming.measureSync(
      "reply.resolve_explicit_steer_target",
      () => resolveActiveExplicitSteerSessionKey({ cfg, ctx: finalized }),
    );
    if (explicitSteerTargetSessionKey) {
      finalized.CommandTargetSessionKey = explicitSteerTargetSessionKey;
    }
    const initialAgentScope = await resolverTiming.measure("reply.resolve_agent_scope", () =>
      resolveReplyAgentScope({ cfg, ctx: finalized, signal: opts?.abortSignal }),
    );
    assertReplyPreprocessingActive(opts?.abortSignal);
    opts?.operatorAuthority?.assertCurrent();
    opts?.internalEventExecution?.assertCurrent?.();
    const refusal = readAgentDatabaseAdmissionRefusal(initialAgentScope.agentId);
    if (refusal) {
      return { text: `${refusal.reason}\n${refusal.repairHint}`, isError: true };
    }
    const agentSessionKey = initialAgentScope.agentSessionKey;
    const agentId = initialAgentScope.agentId;
    if (
      preparedReplyDispatchRuntime &&
      !publishedModelCatalogOwnerMatchesAgent(preparedReplyDispatchRuntime, agentId)
    ) {
      throw new Error(
        `reply model catalog owner changed from ${agentId} to ${preparedReplyDispatchRuntime.agentId}`,
      );
    }
    const preparedAgentDir = preparedReplyDispatchRuntime?.agentDir;
    const preparedWorkspaceDir = preparedReplyDispatchRuntime?.workspaceDir;
    const preparedModelCatalog: ModelCatalogSnapshot | undefined =
      preparedReplyDispatchRuntime?.modelCatalog;
    const traceAttributes = resolverTiming.measureSync("reply.resolve_trace_context", () => ({
      surface: normalizeOptionalString(finalized.Surface ?? finalized.Provider) ?? "unknown",
      hasSessionKey: Boolean(agentSessionKey),
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
    const optsWithSkillFilter =
      mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
    let extractedFileImages: ExtractedFileImage[] | undefined;
    let enableLocalPathSelfServe: ApplyMediaUnderstandingResult["enableLocalPathSelfServe"];
    const agentCfg = cfg.agents?.defaults;
    const agentEntry = resolveAgentConfig(cfg, agentId);
    const configuredThinkingDefault =
      normalizeThinkLevel(agentEntry?.thinkingDefault) ??
      normalizeThinkLevel(agentCfg?.thinkingDefault);
    const sessionCfg = cfg.session;
    const { defaultProvider, defaultModel, aliasIndex } = resolverTiming.measureSync(
      "reply.resolve_default_model",
      () =>
        resolveDefaultModel({
          cfg,
          agentId,
        }),
    );
    const turnModelOverride = resolveTurnModelSelection({
      cfg,
      agentId,
      defaultProvider,
      aliasIndex,
      options: opts,
    });
    let provider = turnModelOverride?.ref.provider ?? defaultProvider;
    let model = turnModelOverride?.ref.model ?? defaultModel;
    let hasResolvedTurnModelOverride = turnModelOverride !== undefined;
    let turnAuthProfile = turnModelOverride?.authProfile;

    const { workspaceDirRaw, workspaceDirForNativeCommand, agentDir, timeoutMs } =
      resolverTiming.measureSync("reply.resolve_workspace_agent_dir", () => {
        const workspaceDirRawLocal =
          resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
        return {
          workspaceDirRaw: workspaceDirRawLocal,
          workspaceDirForNativeCommand: preparedWorkspaceDir ?? workspaceDirRawLocal,
          agentDir: preparedAgentDir ?? resolveAgentDir(cfg, agentId),
          timeoutMs: resolveAgentTimeoutMs({
            cfg,
            overrideSeconds: opts?.timeoutOverrideSeconds,
            overrideMs: opts?.timeoutOverrideMs,
          }),
        };
      });
    const typing = resolverTiming.measureSync("reply.create_typing_controller", () => {
      const typingIntervalSeconds = agentCfg?.typingIntervalSeconds ?? 6;
      const controller = createTypingController({
        onReplyStart: opts?.onReplyStart,
        onCleanup: opts?.onTypingCleanup,
        typingIntervalSeconds,
        keepalive: opts?.typingKeepalive ?? true,
        log: defaultRuntime.log,
      });
      opts?.onTypingController?.(controller);
      return controller;
    });
    const rejectSessionPreparation = (error: Error): ReplyPayload => {
      typing.cleanup();
      if (error instanceof ModelSelectionLockedError || error instanceof SessionResetCleanupError) {
        recordReplyPreRunRejection(
          resolveReplyOperationRunState(opts),
          error instanceof SessionResetCleanupError
            ? "session-directive-rejected"
            : "model-selection-locked",
        );
      }
      return { text: error.message };
    };

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
          preparedModelCatalog,
          typing,
          opts: optsWithSkillFilter,
          skillFilter: mergedSkillFilter,
        }),
    );
    if (nativeSlashCommandFastReply.handled) {
      logResolverTiming("completed", "native_slash_command_fast_path");
      return finishCommandTurn({
        opts,
        ctx: finalized,
        cfg,
        reply: nativeSlashCommandFastReply.reply,
      });
    }
    const optsWithCommandQueueOverride = nativeSlashCommandFastReply.queueModeOverride
      ? { ...optsWithSkillFilter, queueModeOverride: nativeSlashCommandFastReply.queueModeOverride }
      : optsWithSkillFilter;

    const acpWorkspaceProvisioningInput = isImplicitAcpWorkspaceCandidate(cfg, agentId)
      ? await traceGetReplyPhase("reply.resolve_acp_workspace_provisioning", async () => {
          // Implicit ACP agents need the live session's ACP meta (per-session cwd
          // from /acp spawn --cwd or /acp cwd) before workspace scaffolding runs.
          const state = await resolveReplySessionPreprocessingState({ ctx: finalized, cfg });
          assertReplyPreprocessingActive(optsWithSkillFilter?.abortSignal);
          return {
            cfg,
            agentId,
            sessionKey: state.sessionKey,
            ...(state.sessionEntry ? { sessionEntry: state.sessionEntry } : {}),
          };
        })
      : { cfg, agentId, ...(agentSessionKey ? { sessionKey: agentSessionKey } : {}) };

    let workspace: Awaited<ReturnType<typeof prepareReplyWorkspace>>;
    try {
      workspace = await traceGetReplyPhase("reply.ensure_workspace", () =>
        prepareReplyWorkspace({
          dir: workspaceDirRaw,
          ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
          skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
          useFastTestBootstrap,
          provisioningInput: acpWorkspaceProvisioningInput,
          abortSignal: optsWithSkillFilter?.abortSignal,
          operatorAuthority: optsWithSkillFilter?.operatorAuthority,
        }),
      );
    } catch (error) {
      if (
        !(error instanceof WorkspaceAliasRepointedError || error instanceof WorkspaceVanishedError)
      ) {
        throw error;
      }
      // Permanent failures must finish ingress even in tool-only conversations.
      // Keep host paths in operator logs.
      typing.cleanup();
      logVerbose(`workspace unavailable; replying with repair notice: ${error.message}`);
      const text =
        error instanceof WorkspaceAliasRepointedError
          ? "⚠️ This agent's workspace state needs repair: the configured workspace path no longer matches its stored identity. Ask the gateway operator to run `openclaw doctor --fix` and confirm the move only if the same workspace moved."
          : "⚠️ This agent's workspace is missing on the gateway host. Ask the operator to restore the workspace from backup and run `openclaw doctor`.";
      return markReplyPayloadForSourceSuppressionDelivery({ text });
    }
    const workspaceDir = preparedWorkspaceDir ?? workspace.dir;
    const workspaceContext = { cfg, agentId, agentDir, workspaceDir };
    const skillSnapshotScope = { workspaceDir, config: cfg, agentId };

    const remoteMediaNeedsStaging =
      !isFastTestEnv &&
      !inboundMediaWasAlreadyStaged &&
      normalizeOptionalString(finalized.MediaRemoteHost) &&
      hasInboundMedia(finalized);
    const remoteMediaSessionState = remoteMediaNeedsStaging
      ? await resolveReplySessionPreprocessingState({ ctx: finalized, cfg })
      : undefined;
    if (remoteMediaSessionState) {
      const entry = remoteMediaSessionState.sessionEntry;
      const selectedSkills =
        entry?.skillLibrarySelections ??
        entry?.skillsSnapshot?.librarySelections ??
        finalized.SessionCreation?.skillLibrarySelections;
      // This write precedes session initialization and media understanding. Give
      // it the same private-skill isolation identity as the admitted run.
      const stagingSkillsSnapshot = selectedSkills?.length
        ? (
            await (
              await import("../../skills/runtime/session-snapshot.js")
            ).resolveReusableWorkspaceSkillSnapshot({
              ...skillSnapshotScope,
              executionWorkspaceDir: entry?.worktree?.canonicalWorkspaceDir ?? workspaceDir,
              existingSnapshot: entry?.skillsSnapshot,
              librarySelections: selectedSkills,
              skillFilter: mergedSkillFilter,
              skillOverrides: entry?.toolOverrides?.skills,
            })
          ).snapshot
        : undefined;
      assertReplyPreprocessingActive(optsWithSkillFilter?.abortSignal);
      await traceGetReplyPhase("reply.stage_remote_media_pre_understanding", () =>
        stageRemoteInboundMediaIfNeeded({
          ctx: finalized,
          cfg,
          agentId,
          sessionKey: remoteMediaSessionState.sessionKey,
          workspaceDir,
          skillsSnapshot: stagingSkillsSnapshot,
          abortSignal: optsWithSkillFilter?.abortSignal,
        }),
      );
    }

    const mediaUnderstandingRequested =
      !isFastTestEnv && hasInboundMediaForUnderstanding(finalized);
    const linkUnderstandingRequested = !isFastTestEnv && hasLinkCandidate(finalized);
    const preprocessingState =
      mediaUnderstandingRequested || linkUnderstandingRequested
        ? (remoteMediaSessionState ??
          (await traceGetReplyPhase("reply.resolve_session_preprocessing_state", () =>
            resolveReplySessionPreprocessingState({ ctx: finalized, cfg }),
          )))
        : undefined;
    assertReplyPreprocessingActive(optsWithSkillFilter?.abortSignal);
    const utilityModelSelectionLocked = isModelSelectionLocked(preprocessingState?.sessionEntry);

    if (mediaUnderstandingRequested) {
      // Native harnesses receive images directly, but generic file attachments
      // still need host extraction. Only explicitly configured STT runs when locked.
      const mediaResult = await traceGetReplyPhase("reply.apply_media_understanding", () =>
        applyMediaUnderstandingIfNeeded({
          ctx: finalized,
          ...workspaceContext,
          activeModel: {
            provider,
            model,
            api: findModelInCatalog(preparedModelCatalog?.entries ?? [], provider, model)?.api,
          },
          // Cache and classify now; the final provider and owner policy are
          // resolved later, immediately before the embedded turn starts.
          selfServeLocalPaths: false,
          ...(utilityModelSelectionLocked
            ? {
                processingMode:
                  hasInboundAudio(finalized) && hasExplicitAudioUnderstandingConfig(cfg)
                    ? ("audio-and-files" as const)
                    : ("files-only" as const),
              }
            : {}),
        }),
      );
      extractedFileImages = mediaResult?.extractedFileImages;
      enableLocalPathSelfServe = mediaResult?.enableLocalPathSelfServe;
    }
    if (linkUnderstandingRequested && !utilityModelSelectionLocked) {
      await traceGetReplyPhase("reply.apply_link_understanding", () =>
        applyLinkUnderstandingIfNeeded({
          ctx: finalized,
          cfg,
          signal: optsWithSkillFilter?.abortSignal,
        }),
      );
    }
    // Cleanup may resolve after cancellation; hooks must stay inside the reply lifetime.
    assertReplyPreprocessingActive(optsWithSkillFilter?.abortSignal);
    emitPreAgentMessageHooks({
      ctx: finalized,
      cfg,
      isFastTestEnv,
    });

    const commandAuthorized = finalized.CommandAuthorized;
    let sessionState: Awaited<ReturnType<typeof initSessionState>>;
    try {
      sessionState = useFastTestBootstrap
        ? await initFastReplySessionState({
            ctx: finalized,
            cfg,
            agentId,
            commandAuthorized,
            workspaceDir,
          })
        : await traceGetReplyPhase("reply.init_session_state", () =>
            initSessionState({
              ...resolveReplySessionInitializationOptions(optsWithSkillFilter),
              ctx: finalized,
              cfg,
              commandAuthorized,
            }),
          );
    } catch (error) {
      if (error instanceof ModelSelectionLockedError || error instanceof SessionResetCleanupError) {
        return rejectSessionPreparation(error);
      }
      throw error;
    }
    const awaitSessionDiffBaseline = useFastTestBootstrap
      ? undefined
      : baseline.start({ agentId, workspaceDir, sessionState }, traceGetReplyPhase);
    const {
      sessionCtx,
      sessionEntry,
      initialSessionEntry,
      sessionEntryHandle,
      previousSessionEntry,
      previousSessionMemory,
      previousSessionResetMessages,
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
    } = sessionState;
    const replySession = { sessionEntry, sessionStore, sessionKey, storePath };
    const replyContext = { ...workspaceContext, ...replySession };
    const sessionModelSelectionLocked = isModelSelectionLocked(sessionEntry);
    const scheduledModel = opts?.scheduledAutomation
      ? await resolveScheduledSessionModelSelection({
          automation: opts.scheduledAutomation,
          cfg,
          agentId,
          agentDir,
          workspaceDir,
          sessionKey,
          sessionEntry,
          publishedRuntime: preparedReplyDispatchRuntime,
        })
      : undefined;
    if (scheduledModel && !sessionModelSelectionLocked) {
      provider = scheduledModel.provider;
      model = scheduledModel.model;
      hasResolvedTurnModelOverride = true;
      turnAuthProfile = scheduledModel.configuredProfileId
        ? { provider, model, profileId: scheduledModel.configuredProfileId }
        : undefined;
    }
    if (sessionModelSelectionLocked && hasResolvedTurnModelOverride) {
      // Turn-local overrides cannot retarget a native harness with a locked model.
      provider = defaultProvider;
      model = defaultModel;
      hasResolvedTurnModelOverride = false;
      turnAuthProfile = undefined;
    }
    // Utility-model narration is turn-local decoration. Initialize the durable
    // session first, then keep it completely outside model-locked native runs.
    const admittedSessionSettings = optsWithCommandQueueOverride?.admittedSessionSettings;
    const turnToolOverrides = admittedSessionSettings
      ? admittedSessionSettings.toolOverrides
      : sessionEntry.toolOverrides;
    const optsWithSessionSkillOverrides = {
      ...optsWithCommandQueueOverride,
      ...(scheduledModel ? { thinkingLevelOverride: scheduledModel.thinkingLevelOverride } : {}),
      ...(scheduledModel && opts?.scheduledAutomation && !sessionModelSelectionLocked
        ? {
            scheduledAutomation: {
              ...opts.scheduledAutomation,
              modelFallbackPolicy: {
                useSubagentFallbacks: scheduledModel.useSubagentFallbacks,
                inheritDefaultFallbacksForAgentStringModel:
                  scheduledModel.inheritDefaultFallbacksForAgentStringModel,
                sessionModelOverrideSource:
                  scheduledModel.modelSource === "session"
                    ? (resolveSessionModelOverrideSource(sessionEntry) ?? undefined)
                    : undefined,
              },
            },
          }
        : {}),
      ...(turnToolOverrides?.skills ? { skillOverrides: turnToolOverrides.skills } : {}),
      ...(awaitSessionDiffBaseline ? { awaitSessionDiffBaseline } : {}),
    };
    const resolvedOpts = attachProgressNarratorToReplyOptions({
      cfg,
      agentId,
      userMessage: finalized.agentText,
      opts: optsWithSessionSkillOverrides,
      disabled: sessionModelSelectionLocked,
    });
    let { abortedLastRun } = sessionState;
    resolverTimingSessionKey = sessionKey ?? resolverTimingSessionKey;
    resolvedOpts?.onSessionPrepared?.({
      sessionKey,
      sessionId,
      lifecycleRevision: sessionEntry.lifecycleRevision,
      storePath,
    });

    if (resetTriggered && normalizeOptionalString(bodyStripped)) {
      const { applyResetModelOverride } = await import("./session-reset-model.js");
      try {
        await applyResetModelOverride({
          ...replyContext,
          bodyStripped,
          sessionCtx,
          sessionEntryHandle,
          defaultProvider,
          defaultModel,
          aliasIndex,
        });
      } catch (error) {
        if (
          error instanceof ModelSelectionLockedError ||
          isSessionWorkStartInvalidatedError(error)
        ) {
          return rejectSessionPreparation(error);
        }
        throw error;
      }
    }

    const channelModelOverride = cfg.channels?.modelByChannel
      ? resolveChannelModelOverride({
          cfg,
          channel:
            groupResolution?.channel ??
            sessionDeliveryChannel(sessionEntry) ??
            finalized.OriginatingChannel ??
            finalized.Provider,
          groupId: groupResolution?.id ?? sessionEntry.groupId,
          groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
          groupChannel:
            sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
          groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
          parentSessionKey: sessionCtx.ModelParentSessionKey ?? sessionCtx.ParentSessionKey,
          directUserIds: [
            sessionDeliveryOrigin(sessionEntry)?.nativeDirectUserId,
            sessionDeliveryOrigin(sessionEntry)?.from,
            sessionDeliveryOrigin(sessionEntry)?.to,
            finalized.OriginatingTo,
            finalized.From,
            finalized.SenderId,
          ],
        })
      : null;
    const resolvedChannelModelOverride =
      channelModelOverride && !hasResolvedTurnModelOverride && !sessionModelSelectionLocked
        ? resolveModelRefFromString({
            cfg,
            agentId,
            raw: channelModelOverride.model,
            defaultProvider,
            aliasIndex,
          })
        : null;
    const primaryProvider = resolvedChannelModelOverride?.ref.provider ?? defaultProvider;
    const primaryModel = resolvedChannelModelOverride?.ref.model ?? defaultModel;
    const {
      modelOverride: storedModelOverride,
      autoFallbackPrimaryProbe,
      hasEffectiveStoredModelOverride,
    } = await resolveReplyStoredModelSelection({
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey:
        sessionEntry.parentSessionKey ??
        sessionCtx.ModelParentSessionKey ??
        sessionCtx.ParentSessionKey,
      defaultProvider,
      defaultModel,
      primaryProvider,
      primaryModel,
      sessionModelSelectionLocked,
      hasResolvedTurnModelOverride,
    });
    if (storedModelOverride) {
      provider = storedModelOverride.provider;
      model = storedModelOverride.model;
    }
    if (
      !hasResolvedTurnModelOverride &&
      !hasEffectiveStoredModelOverride &&
      resolvedChannelModelOverride
    ) {
      provider = resolvedChannelModelOverride.ref.provider;
      model = resolvedChannelModelOverride.ref.model;
    }

    const conversation =
      resolvedOpts?.replyConversation ??
      prepareReplyConversation({
        ctx: sessionCtx,
        sessionEntry: sessionStore[sessionKey] ?? sessionEntry,
        groupResolution,
      });

    const directiveResult = await traceGetReplyPhase("reply.resolve_directives", () =>
      resolveReplyDirectives({
        ctx: finalized,
        ...replyContext,
        agentCfg,
        sessionCtx,
        sessionScope,
        conversation,
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
        hasResolvedTurnModelOverride,
        typing,
        opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
        skillFilter: mergedSkillFilter,
        preparedModelCatalog,
      }),
    );
    if (directiveResult.kind === "reply") {
      logResolverTiming("completed", "directive_reply");
      return finishCommandTurn({ opts, ctx: finalized, cfg, reply: directiveResult.reply });
    }
    const {
      command,
      defaultActivation,
      provider: resolvedProvider,
      model: resolvedModel,
      requestedRouteResolution,
      modelState,
      resolveModelLevels,
      inlineStatusRequested,
    } = directiveResult.result;
    let { directives } = directiveResult.result;
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
      const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");
      const action = resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
      await resolvedOpts?.awaitSessionDiffBaseline?.();
      assertReplyPreprocessingActive(resolvedOpts?.abortSignal);
      resolvedOpts?.operatorAuthority?.assertCurrent();
      command.assertOwnerCurrent?.();
      await emitResetCommandHooks({
        action,
        agentId,
        ctx,
        cfg,
        command,
        sessionKey,
        storePath,
        sessionEntry,
        previousSessionEntry,
        previousSessionMemory,
        previousSessionResetMessages,
        onObservedReplyDelivery: resolvedOpts?.onObservedReplyDelivery,
        workspaceDir,
      });
    };

    const shouldPrepareStatusThinkingCatalog =
      inlineStatusRequested ||
      directives.hasStatusDirective ||
      command.commandBodyNormalized.trim() === "/status";
    const statusThinkingCatalog = shouldPrepareStatusThinkingCatalog
      ? await traceGetReplyPhase("reply.prepare_status_thinking_catalog", () => {
          assertReplyPreprocessingActive(resolvedOpts?.abortSignal);
          return racePromiseWithAbortSignal(
            modelState.resolveThinkingCatalog(),
            resolvedOpts?.abortSignal,
          );
        })
      : undefined;
    assertReplyPreprocessingActive(resolvedOpts?.abortSignal);

    const inlineActionResult = await traceGetReplyPhase("reply.handle_inline_actions", () =>
      handleInlineActions({
        ...directiveResult.result,
        ctx,
        sessionCtx,
        ...replyContext,
        ...(initialSessionEntry ? { initialSessionEntry } : {}),
        allowCreateSessionEntry: useFastTestBootstrap && initialSessionEntry === undefined,
        previousSessionEntry,
        previousSessionMemory,
        previousSessionResetMessages,
        sessionScope,
        isGroup,
        opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
        typing,
        defaultActivation: () => defaultActivation,
        thinkingCatalog: statusThinkingCatalog,
        resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
        provider,
        model,
        // Inline commands do not inherit the full turn's exec overrides.
        execOverrides: undefined,
        abortedLastRun,
        skillFilter: mergedSkillFilter,
      }),
    );
    await maybeEmitMissingResetHooks();
    if (inlineActionResult.kind === "reply") {
      logResolverTiming("completed", "inline_action_reply");
      return finishCommandTurn({ opts, ctx: finalized, cfg, reply: inlineActionResult.reply });
    }
    directives = inlineActionResult.directives;
    const explicitSkillSelections = inlineActionResult.explicitSkillSelections;
    const queueModeOverride = inlineActionResult.queueModeOverride;
    const preparedReplyOpts = withExtractedFileImages(resolvedOpts, extractedFileImages);
    abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;
    const runAutoFallbackPrimaryProbe =
      directives.hasModelDirective ||
      (autoFallbackPrimaryProbe &&
        resolvedOpts?.operatorAuthority?.modelPolicy &&
        !resolvedOpts.operatorAuthority.modelPolicy.allows(autoFallbackPrimaryProbe))
        ? undefined
        : autoFallbackPrimaryProbe;
    let runProvider = runAutoFallbackPrimaryProbe?.provider ?? provider;
    let runModel = runAutoFallbackPrimaryProbe?.model ?? model;
    let runModelState = modelState;
    let resolveRunModelLevels = resolveModelLevels;
    if (runAutoFallbackPrimaryProbe) {
      try {
        runModelState = await createModelSelectionState({
          cfg,
          agentId,
          agentCfg,
          ...replySession,
          parentSessionKey:
            sessionEntry.parentSessionKey ??
            sessionCtx.ModelParentSessionKey ??
            sessionCtx.ParentSessionKey,
          defaultProvider,
          defaultModel,
          primaryProvider,
          primaryModel,
          provider: runProvider,
          model: runModel,
          hasModelDirective: false,
          skipStoredModelOverride: true,
          hasResolvedTurnModelOverride,
          preparedModelCatalog,
          operatorAuthority: resolvedOpts?.operatorAuthority,
        });
      } catch (error) {
        if (
          error instanceof ModelSelectionLockedError ||
          isSessionWorkStartInvalidatedError(error)
        ) {
          return rejectSessionPreparation(error);
        }
        throw error;
      }
      if (runModelState.operatorModelOverride) {
        runProvider = runModelState.provider;
        runModel = runModelState.model;
      }
      resolveRunModelLevels = await createReplyProbeModelLevelResolver({
        modelState: runModelState,
        abortSignal: resolvedOpts?.abortSignal,
        previous: resolveModelLevels,
        directives,
        sessionEntry,
        thinkingLevelOverride: resolvedOpts?.thinkingLevelOverride,
        configuredThinkingDefault,
        hasConfiguredReasoningDefault:
          agentEntry?.reasoningDefault != null || agentCfg?.reasoningDefault != null,
      });
    }
    const modelLevels = await resolveRunModelLevels();

    let stagedAttachmentPaths: ReadonlyMap<number, string> = hasStagedMediaFacts(finalized.media)
      ? new Map(
          (finalized.media ?? []).flatMap((fact, index) =>
            fact.path ? [[index, fact.path] as const] : [],
          ),
        )
      : new Map<number, string>();
    // Already-staged facts or SDK projections must remain a single-stage contract.
    if (
      !useFastTestBootstrap &&
      sessionKey &&
      !inboundMediaWasAlreadyStaged &&
      !hasStagedMediaFacts(ctx.media) &&
      hasInboundMedia(ctx)
    ) {
      const stagingSessionEntry =
        sessionEntryHandle?.getCurrent() ?? sessionStore?.[sessionKey] ?? sessionEntry;
      const stagingWorkspaceDir =
        resolveIngressWorkspaceOverrideForSessionRun({
          spawnedBy: stagingSessionEntry.spawnedBy,
          workspaceDir: stagingSessionEntry.spawnedWorkspaceDir,
          cwd: stagingSessionEntry.spawnedCwd,
        }) ?? workspaceDir;
      // Private library selections change the sandbox isolation identity. Resolve
      // the current selection before staging so the attachment and admitted run
      // select the same SSH runtime, even when a prior snapshot needs refreshing.
      const selectedSkills =
        stagingSessionEntry.skillLibrarySelections ??
        stagingSessionEntry.skillsSnapshot?.librarySelections;
      const stagingSkillsSnapshot = selectedSkills?.length
        ? (
            await (
              await import("../../skills/runtime/session-snapshot.js")
            ).resolveReusableWorkspaceSkillSnapshot({
              ...skillSnapshotScope,
              executionWorkspaceDir:
                stagingSessionEntry.worktree?.canonicalWorkspaceDir ?? workspaceDir,
              existingSnapshot: stagingSessionEntry.skillsSnapshot,
              librarySelections: selectedSkills,
              skillFilter: preparedReplyOpts?.skillFilter,
              skillOverrides: preparedReplyOpts?.skillOverrides,
            })
          ).snapshot
        : undefined;
      const stageResult = await traceGetReplyPhase("reply.stage_media", async () =>
        (await stageSandboxMediaRuntimeLoader.load()).stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          agentId,
          sessionKey,
          workspaceDir: stagingWorkspaceDir,
          skillsSnapshot: stagingSkillsSnapshot,
          abortSignal: optsWithSkillFilter?.abortSignal,
          awaitSessionDiffBaseline: resolvedOpts?.awaitSessionDiffBaseline,
        }),
      );
      stagedAttachmentPaths = stageResult.staged;
    }

    if (
      enableLocalPathSelfServe &&
      resolvedOpts?.disableTools !== true &&
      (await canReadReplyAttachmentPaths({
        cfg,
        agentId,
        sessionKey,
        sessionCtx,
        workspaceDir,
        stagedAttachmentCount: stagedAttachmentPaths.size,
        spawnedBy: sessionEntry.spawnedBy,
        senderIsOwner: command.senderIsOwner,
        modelProvider: runProvider,
        modelId: runModel,
        operatorProfileId: resolvedOpts?.operatorAuthority?.profileId,
        toolsAllow: resolvedOpts?.toolsAllow,
        sessionEntry,
      }))
    ) {
      enableLocalPathSelfServe(
        [finalized, sessionCtx],
        stagedAttachmentPaths.size > 0 ? stagedAttachmentPaths : undefined,
      );
    }

    logResolverTiming("milestone", "before_run_prepared_reply");
    const replyResult = await traceGetReplyPhase("reply.run_prepared_reply", () =>
      runPreparedReply({
        ...directiveResult.result,
        ctx,
        sessionCtx,
        conversation,
        ...replyContext,
        agentCfg,
        sessionCfg,
        commandAuthorized,
        directives,
        ...modelLevels,
        modelState: runModelState,
        provider: runProvider,
        model: runModel,
        ...(hasResolvedTurnModelOverride &&
        turnAuthProfile?.provider === runProvider &&
        turnAuthProfile.model === runModel
          ? { configuredProfileId: turnAuthProfile.profileId }
          : {}),
        requestedRouteResolution: runAutoFallbackPrimaryProbe
          ? runModelState.requestedRouteResolution
          : requestedRouteResolution,
        typing,
        opts: queueModeOverride ? { ...preparedReplyOpts, queueModeOverride } : preparedReplyOpts,
        defaultModel,
        timeoutMs,
        isNewSession,
        resetTriggered,
        systemSent,
        sessionId,
        abortedLastRun,
        explicitSkillSelections,
        autoFallbackPrimaryProbe: runAutoFallbackPrimaryProbe,
      }),
    );
    if (profilerEnabled) {
      logResolverTiming("completed", "prepared_reply");
    }
    return replyResult;
  } finally {
    if (source.created) {
      retireUnadoptedReplySource(source.input);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
