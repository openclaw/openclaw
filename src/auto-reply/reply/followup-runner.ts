import crypto from "node:crypto";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  buildAgentRuntimeDeliveryPlan,
  buildAgentRuntimeOutcomePlan,
} from "../../agents/runtime-plan/build.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { readStringValue } from "../../shared/string-coerce.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "../continuation/state.js";
import type { ContinueWorkRequest } from "../continuation/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runCliAgentWithLifecycle } from "./agent-runner-cli-dispatch.js";
import {
  resolveRunAfterAutoFallbackPrimaryProbeRecheck,
  resolveSessionRuntimeOverrideForProvider,
} from "./agent-runner-execution.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import {
  completeFollowupRunLifecycle,
  isFollowupRunAborted,
  refreshQueuedFollowupSession,
  type FollowupRun,
} from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveReplyRunFireReason } from "./run-provenance.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedPiAgent>>;

type FollowupAgentEvent = { stream: string; data: Record<string, unknown> };

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

function filterStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

async function forwardFollowupProgressEvent(params: {
  evt: FollowupAgentEvent;
  opts?: GetReplyOptions;
  detailMode?: "explain" | "raw";
  emitChannelProgress?: boolean;
  onCompactionComplete?: () => void;
}) {
  const { evt, opts } = params;
  const emitChannelProgress = params.emitChannelProgress !== false;
  if (!emitChannelProgress && evt.stream !== "compaction") {
    return;
  }

  if (evt.stream === "tool") {
    const phase = readStringValue(evt.data.phase) ?? "";
    const name = readStringValue(evt.data.name);
    if (phase === "start" || phase === "update") {
      await opts?.onToolStart?.({
        name,
        phase,
        args:
          evt.data.args && typeof evt.data.args === "object"
            ? (evt.data.args as Record<string, unknown>)
            : undefined,
        detailMode: params.detailMode,
      });
    }
  }

  const suppressItemChannelProgress =
    evt.stream === "item" &&
    evt.data.suppressChannelProgress === true &&
    Boolean(opts?.onToolStart);
  if (evt.stream === "item" && !suppressItemChannelProgress) {
    await opts?.onItemEvent?.({
      itemId: readStringValue(evt.data.itemId),
      kind: readStringValue(evt.data.kind),
      title: readStringValue(evt.data.title),
      name: readStringValue(evt.data.name),
      phase: readStringValue(evt.data.phase),
      status: readStringValue(evt.data.status),
      summary: readStringValue(evt.data.summary),
      progressText: readStringValue(evt.data.progressText),
      meta: readStringValue(evt.data.meta),
      approvalId: readStringValue(evt.data.approvalId),
      approvalSlug: readStringValue(evt.data.approvalSlug),
    });
  }

  if (evt.stream === "plan") {
    await opts?.onPlanUpdate?.({
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      explanation: readStringValue(evt.data.explanation),
      steps: filterStringArray(evt.data.steps),
      source: readStringValue(evt.data.source),
    });
  }

  if (evt.stream === "approval") {
    await opts?.onApprovalEvent?.({
      phase: readStringValue(evt.data.phase),
      kind: readStringValue(evt.data.kind),
      status: readStringValue(evt.data.status),
      title: readStringValue(evt.data.title),
      itemId: readStringValue(evt.data.itemId),
      toolCallId: readStringValue(evt.data.toolCallId),
      approvalId: readStringValue(evt.data.approvalId),
      approvalSlug: readStringValue(evt.data.approvalSlug),
      command: readStringValue(evt.data.command),
      host: readStringValue(evt.data.host),
      reason: readStringValue(evt.data.reason),
      scope: readApprovalScopeValue(evt.data.scope),
      message: readStringValue(evt.data.message),
    });
  }

  if (evt.stream === "command_output") {
    await opts?.onCommandOutput?.({
      itemId: readStringValue(evt.data.itemId),
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      toolCallId: readStringValue(evt.data.toolCallId),
      name: readStringValue(evt.data.name),
      output: readStringValue(evt.data.output),
      status: readStringValue(evt.data.status),
      exitCode:
        typeof evt.data.exitCode === "number" || evt.data.exitCode === null
          ? evt.data.exitCode
          : undefined,
      durationMs: typeof evt.data.durationMs === "number" ? evt.data.durationMs : undefined,
      cwd: readStringValue(evt.data.cwd),
    });
  }

  if (evt.stream === "patch") {
    await opts?.onPatchSummary?.({
      itemId: readStringValue(evt.data.itemId),
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      toolCallId: readStringValue(evt.data.toolCallId),
      name: readStringValue(evt.data.name),
      added: filterStringArray(evt.data.added),
      modified: filterStringArray(evt.data.modified),
      deleted: filterStringArray(evt.data.deleted),
      summary: readStringValue(evt.data.summary),
    });
  }

  if (evt.stream === "compaction") {
    const phase = readStringValue(evt.data.phase) ?? "";
    if (phase === "start") {
      await opts?.onCompactionStart?.();
    }
    if (phase === "end" && evt.data?.completed === true) {
      params.onCompactionComplete?.();
      await opts?.onCompactionEnd?.();
    }
  }
}

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  toolProgressDetail?: "explain" | "raw";
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    toolProgressDetail,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (
    payloads: ReplyPayload[],
    queued: FollowupRun,
    resolvedRun: { provider: string; modelId: string },
    options: { mirror?: boolean } = {},
  ) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
    const deliveryPlan = buildAgentRuntimeDeliveryPlan({
      provider: resolvedRun.provider,
      modelId: resolvedRun.modelId,
      config: runtimeConfig,
      workspaceDir: queued.run.workspaceDir,
      agentDir: queued.run.agentDir,
    });

    const sendablePayloads = payloads.filter(
      (payload): payload is ReplyPayload =>
        hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload),
    );

    if (sendablePayloads.length === 0) {
      return;
    }

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      defaultRuntime.error?.(
        "followup queue: completed with payloads but no origin route or visible dispatcher is available",
      );
      return;
    }

    let crossChannelRouteFailureNeedsNotice = false;
    let routedAnyCrossChannelPayloadToOrigin = false;
    for (const payload of sendablePayloads) {
      const providerRoute = deliveryPlan.resolveFollowupRoute({
        payload,
        originatingChannel,
        originatingTo,
        originRoutable: Boolean(shouldRouteToOriginating),
        dispatcherAvailable: Boolean(opts?.onBlockReply),
      });
      if (providerRoute?.route === "drop") {
        logVerbose(
          `followup queue: provider hook dropped payload route reason=${providerRoute.reason ?? "unspecified"}`,
        );
        continue;
      }
      const deliveryRoute =
        providerRoute?.route === "origin" && shouldRouteToOriginating
          ? "origin"
          : providerRoute?.route === "dispatcher" && opts?.onBlockReply
            ? "dispatcher"
            : shouldRouteToOriginating
              ? "origin"
              : opts?.onBlockReply
                ? "dispatcher"
                : undefined;
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (deliveryRoute === "origin" && isRoutableChannel(originatingChannel) && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          requesterSenderId: queued.run.senderId,
          requesterSenderName: queued.run.senderName,
          requesterSenderUsername: queued.run.senderUsername,
          requesterSenderE164: queued.run.senderE164,
          threadId: queued.originatingThreadId,
          cfg: runtimeConfig,
          mirror: options.mirror,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (opts?.onBlockReply) {
            if (origin && origin === provider) {
              await opts.onBlockReply(payload);
            } else {
              crossChannelRouteFailureNeedsNotice = true;
            }
          } else {
            defaultRuntime.error?.(`followup queue: route-reply failed: ${errorMsg}`);
          }
        } else {
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (origin && provider && origin !== provider) {
            routedAnyCrossChannelPayloadToOrigin = true;
          }
        }
      } else if (deliveryRoute === "dispatcher" && opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
    if (
      crossChannelRouteFailureNeedsNotice &&
      !routedAnyCrossChannelPayloadToOrigin &&
      opts?.onBlockReply
    ) {
      await opts.onBlockReply({
        text:
          "Follow-up completed, but OpenClaw could not deliver it to the originating " +
          "channel. The reply content was not forwarded to this channel to avoid " +
          "cross-channel misdelivery.",
        isError: true,
      });
    }
  };

  return async (queued: FollowupRun) => {
    if (isFollowupRunAborted(queued)) {
      completeFollowupRunLifecycle(queued);
      typing.markRunComplete();
      typing.markDispatchIdle();
      return;
    }
    const endDeliveryCorrelations = (queued.deliveryCorrelations ?? [])
      .map((correlation) => correlation.begin())
      .filter((end): end is () => void => typeof end === "function");
    const queuedImages = queued.images ?? opts?.images;
    const queuedImageOrder = queued.imageOrder ?? opts?.imageOrder;
    let replyOperation: ReturnType<typeof createReplyOperation> | undefined;

    try {
      queued.run.config = await resolveQueuedReplyExecutionConfig(queued.run.config, {
        originatingChannel: queued.originatingChannel,
        messageProvider: queued.run.messageProvider,
        originatingAccountId: queued.originatingAccountId,
        agentAccountId: queued.run.agentAccountId,
      });
      const replySessionKey = queued.run.sessionKey ?? sessionKey;
      const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
      let effectiveQueued =
        runtimeConfig === queued.run.config
          ? queued
          : { ...queued, run: { ...queued.run, config: runtimeConfig } };
      let run = effectiveQueued.run;
      let activeSessionEntry =
        (replySessionKey ? sessionStore?.[replySessionKey] : undefined) ??
        (replySessionKey === sessionKey ? sessionEntry : undefined);
      run = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: activeSessionEntry,
        sessionKey: replySessionKey,
      });
      if (run !== effectiveQueued.run) {
        effectiveQueued = { ...effectiveQueued, run };
      }
      const shouldEmitVerboseProgress = () => run.verboseLevel !== "off";
      const shouldSuppressDefaultToolProgressMessages = () =>
        opts?.suppressDefaultToolProgressMessages === true && !shouldEmitVerboseProgress();
      const shouldEmitToolResultProgress = () =>
        shouldEmitVerboseProgress() && !shouldSuppressDefaultToolProgressMessages();
      const shouldEmitToolOutputProgress = () =>
        run.verboseLevel === "full" && !shouldSuppressDefaultToolProgressMessages();
      let progressDeliveryChain: Promise<void> = Promise.resolve();
      const pendingProgressDeliveries = new Set<Promise<void>>();
      const enqueueProgressDelivery = (deliver: () => Promise<void>) => {
        progressDeliveryChain = progressDeliveryChain.then(deliver).catch((err) => {
          logVerbose(`followup queue: progress delivery failed: ${formatErrorMessage(err)}`);
        });
        const task = progressDeliveryChain.finally(() => {
          pendingProgressDeliveries.delete(task);
        });
        pendingProgressDeliveries.add(task);
        return task;
      };
      const drainProgressDeliveries = async () => {
        while (pendingProgressDeliveries.size > 0) {
          await Promise.all(pendingProgressDeliveries);
        }
      };
      replyOperation = createReplyOperation({
        sessionId: run.sessionId,
        sessionKey: replySessionKey ?? "",
        resetTriggered: false,
        upstreamAbortSignal: queued.abortSignal,
      });
      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: run.messageProvider,
        }),
      );
      if (run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: run.sessionKey,
          verboseLevel: run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      let autoCompactionCount = 0;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = run.provider;
      let fallbackModel = run.model;
      activeSessionEntry = await runPreflightCompactionIfNeeded({
        cfg: runtimeConfig,
        followupRun: effectiveQueued,
        promptForEstimate: queued.prompt,
        defaultModel,
        agentCfgContextTokens,
        sessionEntry: activeSessionEntry,
        sessionStore,
        sessionKey: replySessionKey,
        storePath,
        isHeartbeat: opts?.isHeartbeat === true,
        replyOperation,
      });
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      const resolveRunForFallbackCandidate = (
        provider: string,
        model: string,
      ): FollowupRun["run"] => {
        const probe = run.autoFallbackPrimaryProbe;
        const isPrimaryProbeCandidate =
          probe && provider === probe.provider && model === probe.model;
        if (
          probe &&
          provider === probe.fallbackProvider &&
          !isPrimaryProbeCandidate &&
          probe.fallbackAuthProfileId
        ) {
          const candidateRun: FollowupRun["run"] = {
            ...run,
            provider,
            model,
            authProfileId: probe.fallbackAuthProfileId,
          };
          if (probe.fallbackAuthProfileIdSource) {
            candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
          } else {
            delete candidateRun.authProfileIdSource;
          }
          return candidateRun;
        }
        return run;
      };
      const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
        provider: string;
        model: string;
      }): Promise<void> => {
        const probe = run.autoFallbackPrimaryProbe;
        if (!probe) {
          return;
        }
        if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) {
          return;
        }
        if (!replySessionKey || !sessionStore) {
          return;
        }
        const entry = sessionStore[replySessionKey] ?? activeSessionEntry;
        if (!entry || !entryMatchesAutoFallbackPrimaryProbe(entry, probe)) {
          return;
        }
        clearAutoFallbackPrimaryProbeSelection(entry);
        sessionStore[replySessionKey] = entry;
        activeSessionEntry = entry;
        if (!storePath) {
          return;
        }
        await updateSessionStore(storePath, (store) => {
          const persistedEntry = store[replySessionKey];
          if (!persistedEntry) {
            return;
          }
          if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
            return;
          }
          clearAutoFallbackPrimaryProbeSelection(persistedEntry);
          store[replySessionKey] = persistedEntry;
        });
      };
      fallbackProvider = run.provider;
      fallbackModel = run.model;
      replyOperation.setPhase("running");
      let pendingDeferredCliTerminal:
        | {
            provider: string;
            model: string;
            startedAt: number;
          }
        | undefined;
      let queuedUserMessagePersistedAcrossFallback = false;
      let assistantErrorPersistedAcrossFallback = false;
      let attemptContinueWorkRequest: ContinueWorkRequest | undefined;
      try {
        const outcomePlan = buildAgentRuntimeOutcomePlan();
        const fallbackResult = await runWithModelFallback<EmbeddedAgentRunResult>({
          ...resolveModelFallbackOptions(run, runtimeConfig),
          cfg: runtimeConfig,
          runId,
          resolveAgentHarnessRuntimeOverride: (provider) =>
            resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: activeSessionEntry,
            }),
          prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
            await ensureSelectedAgentHarnessPlugin({
              config: runtimeConfig,
              provider,
              modelId: model,
              agentId: run.agentId,
              sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
              agentHarnessRuntimeOverride,
              workspaceDir: run.workspaceDir,
            });
          },
          classifyResult: ({ result, provider, model }) =>
            outcomePlan.classifyRunResult({ result, provider, model }),
          run: async (provider, model, runOptions) => {
            const suppressQueuedUserPersistenceForCandidate =
              (run.suppressNextUserMessagePersistence ?? false) ||
              queuedUserMessagePersistedAcrossFallback;
            const suppressAssistantErrorPersistenceForCandidate =
              assistantErrorPersistedAcrossFallback;
            const candidateRun = resolveRunForFallbackCandidate(provider, model);
            const activeProbe = run.autoFallbackPrimaryProbe;
            if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
              markAutoFallbackPrimaryProbe({
                probe: activeProbe,
                sessionKey: replySessionKey,
              });
            }
            const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
              config: runtimeConfig,
            });
            const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: activeSessionEntry,
            });
            const cliExecutionProvider =
              sessionRuntimeOverride === "pi"
                ? provider
                : ((sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig)
                    ? sessionRuntimeOverride
                    : undefined) ??
                  resolveCliRuntimeExecutionProvider({
                    provider,
                    cfg: runtimeConfig,
                    agentId: run.agentId,
                    modelId: model,
                    authProfileId: selectedAuthProfile.authProfileId,
                  }) ??
                  provider);
            let attemptCompactionCount = 0;
            try {
              if (isCliProvider(cliExecutionProvider, runtimeConfig)) {
                const isRoomEventCliRun = queued.currentInboundEventKind === "room_event";
                const cliSessionBinding = isRoomEventCliRun
                  ? undefined
                  : getCliSessionBinding(activeSessionEntry, cliExecutionProvider);
                const cliLifecycleStartedAt = Date.now();
                pendingDeferredCliTerminal = {
                  provider,
                  model,
                  startedAt: cliLifecycleStartedAt,
                };
                const result = await runCliAgentWithLifecycle({
                  runId,
                  provider: cliExecutionProvider,
                  startedAt: cliLifecycleStartedAt,
                  emitLifecycleTerminal: false,
                  onAgentRunStart: () => opts?.onAgentRunStart?.(runId),
                  suppressAssistantBridge: run.silentExpected,
                  runParams: {
                    replyOperation,
                    sessionId: run.sessionId,
                    sessionKey: replySessionKey,
                    agentId: run.agentId,
                    trigger: opts?.isHeartbeat === true ? "heartbeat" : "user",
                    sessionFile: run.sessionFile,
                    workspaceDir: run.workspaceDir,
                    config: runtimeConfig,
                    prompt: queued.prompt,
                    transcriptPrompt: queued.transcriptPrompt,
                    currentInboundEventKind: queued.currentInboundEventKind,
                    currentInboundContext: queued.currentInboundContext,
                    inputProvenance: run.inputProvenance,
                    provider: cliExecutionProvider,
                    model,
                    ...resolveRunAuthProfile(candidateRun, cliExecutionProvider, {
                      config: runtimeConfig,
                    }),
                    thinkLevel: run.thinkLevel,
                    timeoutMs: run.timeoutMs,
                    runId,
                    extraSystemPrompt: run.extraSystemPrompt,
                    sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                    silentReplyPromptMode: run.silentReplyPromptMode,
                    extraSystemPromptStatic: run.extraSystemPromptStatic,
                    ownerNumbers: run.ownerNumbers,
                    cliSessionId: cliSessionBinding?.sessionId,
                    cliSessionBinding,
                    bootstrapPromptWarningSignaturesSeen,
                    bootstrapPromptWarningSignature:
                      bootstrapPromptWarningSignaturesSeen[
                        bootstrapPromptWarningSignaturesSeen.length - 1
                      ],
                    images: queuedImages,
                    imageOrder: queuedImageOrder,
                    skillsSnapshot: run.skillsSnapshot,
                    messageChannel: queued.originatingChannel ?? undefined,
                    messageProvider: resolveOriginMessageProvider({
                      originatingChannel: queued.originatingChannel,
                      provider: run.messageProvider,
                    }),
                    agentAccountId: run.agentAccountId,
                    disableTools: opts?.disableTools,
                    abortSignal: queued.abortSignal,
                  },
                  transformResult: (rawResult) =>
                    isRoomEventCliRun && rawResult.meta.agentMeta
                      ? (() => {
                          const { cliSessionBinding: _cliSessionBinding, ...agentMeta } =
                            rawResult.meta.agentMeta;
                          return {
                            ...rawResult,
                            meta: {
                              ...rawResult.meta,
                              agentMeta: {
                                ...agentMeta,
                                sessionId: "",
                              },
                            },
                          };
                        })()
                      : rawResult,
                });
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );
                return result;
              }
              pendingDeferredCliTerminal = undefined;
              const result = await runEmbeddedPiAgent({
                allowGatewaySubagentBinding: true,
                replyOperation,
                sessionId: run.sessionId,
                sessionKey: run.sessionKey,
                agentId: run.agentId,
                trigger: "user",
                fireReason: resolveReplyRunFireReason({
                  opts,
                  drainsContinuationDelegateQueue: run.drainsContinuationDelegateQueue === true,
                }),
                parentRunId: opts?.parentRunId,
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: run.messageProvider,
                agentAccountId: run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                groupId: run.groupId,
                groupChannel: run.groupChannel,
                groupSpace: run.groupSpace,
                senderId: run.senderId,
                senderName: run.senderName,
                senderUsername: run.senderUsername,
                senderE164: run.senderE164,
                sessionFile: run.sessionFile,
                agentDir: run.agentDir,
                workspaceDir: run.workspaceDir,
                config: runtimeConfig,
                skillsSnapshot: run.skillsSnapshot,
                prompt: queued.prompt,
                transcriptPrompt: queued.transcriptPrompt,
                currentInboundEventKind: queued.currentInboundEventKind,
                currentInboundContext: queued.currentInboundContext,
                extraSystemPrompt: run.extraSystemPrompt,
                silentReplyPromptMode: run.silentReplyPromptMode,
                sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                forceMessageTool: run.sourceReplyDeliveryMode === "message_tool_only",
                suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
                onUserMessagePersisted: () => {
                  queuedUserMessagePersistedAcrossFallback = true;
                },
                suppressTranscriptOnlyAssistantPersistence:
                  run.suppressTranscriptOnlyAssistantPersistence,
                suppressAssistantErrorPersistence: suppressAssistantErrorPersistenceForCandidate,
                onAssistantErrorMessagePersisted: () => {
                  assistantErrorPersistedAcrossFallback = true;
                },
                ownerNumbers: run.ownerNumbers,
                enforceFinalTag: run.enforceFinalTag,
                allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
                provider,
                model,
                ...selectedAuthProfile,
                thinkLevel: run.thinkLevel,
                verboseLevel: run.verboseLevel,
                reasoningLevel: run.reasoningLevel,
                suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
                execOverrides: run.execOverrides,
                bashElevated: run.bashElevated,
                timeoutMs: run.timeoutMs,
                runId,
                abortSignal: queued.abortSignal,
                images: queuedImages,
                imageOrder: queuedImageOrder,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                // Continuation: thread continueWorkOpts so continue_work is
                // callable on queued followup turns (subagent sessions, continuation-
                // triggered heartbeats). Without this, the tool never registers and
                // subagents cannot self-elect another turn. (#746)
                continueWorkOpts:
                  runtimeConfig?.agents?.defaults?.continuation?.enabled === true
                    ? {
                        requestContinuation: (request: ContinueWorkRequest) => {
                          attemptContinueWorkRequest = request;
                        },
                      }
                    : undefined,
                // Continuation: thread requestCompactionOpts so request_compaction
                // is callable on queued followup turns, not just the first turn.
                requestCompactionOpts:
                  runtimeConfig?.agents?.defaults?.continuation?.enabled === true
                    ? {
                        sessionId: run.sessionId,
                        getContextUsage: () => {
                          // Followup path doesn't have a live token count;
                          // returning null makes request_compaction reply
                          // with guard "context_unknown" instead of pretending
                          // usage is 0% and tripping the 70% floor with a
                          // misleading reason. Main-session callers (see
                          // agent-runner-execution.ts) supply the real ratio
                          // from sessionTokenInfo.
                          return null;
                        },
                        triggerCompaction: async (request) => {
                          try {
                            const { compactEmbeddedPiSession } =
                              await import("../../agents/pi-embedded-runner/compact.queued.js");
                            // Thread the session's active provider/model through so
                            // volitional compaction doesn't fall back to DEFAULT_PROVIDER/MODEL.
                            // Use inner-scope provider/model from the fallback
                            // dispatcher (line 207) so a fallback-selected model
                            // gets the compaction request, not the persisted primary
                            // (which may be in cooldown — would re-fail immediately).
                            // Thread authProfileId only when the inner-scope
                            // provider matches the persisted primary
                            // (the persisted profile is keyed to the primary). On fallback
                            // to a different provider, leave undefined so resolveEmbedded-
                            // CompactionTarget picks the default profile for that provider.
                            const compactionAuthProfileId =
                              provider === run.provider ? run.authProfileId : undefined;
                            const result = await compactEmbeddedPiSession({
                              sessionId: run.sessionId ?? "",
                              runId: request.runId ?? runId,
                              sessionKey: run.sessionKey,
                              sessionFile: run.sessionFile ?? "",
                              workspaceDir: run.workspaceDir ?? process.cwd(),
                              config: run.config,
                              messageProvider: run.messageProvider,
                              provider,
                              model,
                              authProfileId: compactionAuthProfileId,
                              trigger: request.trigger,
                              diagId: request.diagId,
                              traceparent: request.traceparent,
                            });
                            // Honor the real result instead of unconditionally
                            // claiming success; otherwise compaction telemetry lies
                            // and the failure is invisible to the caller.
                            return {
                              ok: result.ok,
                              compacted: result.compacted,
                              reason: result.reason,
                            };
                          } catch (err) {
                            return {
                              ok: false,
                              compacted: false,
                              reason: err instanceof Error ? err.message : String(err),
                            };
                          }
                        },
                      }
                    : undefined,
                toolProgressDetail,
                shouldEmitToolResult: shouldEmitToolResultProgress,
                shouldEmitToolOutput: shouldEmitToolOutputProgress,
                onToolResult: (payload) =>
                  enqueueProgressDelivery(async () => {
                    if (
                      run.sourceReplyDeliveryMode === "message_tool_only" &&
                      run.verboseLevel === "off"
                    ) {
                      return;
                    }
                    await sendFollowupPayloads(
                      [payload],
                      effectiveQueued,
                      {
                        provider,
                        modelId: model,
                      },
                      { mirror: false },
                    );
                  }),
                onAgentEvent: (evt) =>
                  enqueueProgressDelivery(async () => {
                    await forwardFollowupProgressEvent({
                      evt,
                      opts,
                      detailMode: toolProgressDetail,
                      emitChannelProgress: shouldEmitToolResultProgress(),
                      onCompactionComplete: () => {
                        attemptCompactionCount += 1;
                      },
                    });
                  }),
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
        if (
          pendingDeferredCliTerminal &&
          pendingDeferredCliTerminal.provider === fallbackProvider &&
          pendingDeferredCliTerminal.model === fallbackModel
        ) {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "end",
              startedAt: pendingDeferredCliTerminal.startedAt,
              endedAt: Date.now(),
            },
          });
        }
        pendingDeferredCliTerminal = undefined;
        await clearRecoveredAutoFallbackPrimaryProbe({
          provider: fallbackProvider,
          model: fallbackModel,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        replyOperation.fail("run_failed", err);
        if (pendingDeferredCliTerminal) {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "error",
              startedAt: pendingDeferredCliTerminal.startedAt,
              endedAt: Date.now(),
              error: message,
            },
          });
          pendingDeferredCliTerminal = undefined;
        }
        await drainProgressDeliveries();
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
      }

      await drainProgressDeliveries();

      // Consume and dispatch continue_delegate queue enqueued during this
      // followup turn. Parallels the main-session dispatch in agent-runner.ts:
      // without this, delegates queued by continue_work-triggered heartbeats
      // (or any followup turn) stay in the queue until the NEXT inbound
      // message arrives to trigger the main-session dispatch. RFC §3.2.
      if (runtimeConfig?.agents?.defaults?.continuation?.enabled === true && sessionKey) {
        const [
          { dispatchToolDelegates },
          { resolveLiveContinuationRuntimeConfig },
          { loadContinuationChainState, persistContinuationChainState },
          { updateSessionStore, resolveSessionStoreEntry },
        ] = await Promise.all([
          import("../continuation/delegate-dispatch.js"),
          import("../continuation/config.js"),
          import("../continuation/state.js"),
          import("../../config/sessions/store.js"),
        ]);
        const tailUsage = runResult.meta?.agentMeta?.usage;
        const turnTokens = (tailUsage?.input ?? 0) + (tailUsage?.output ?? 0);
        const tailEntry = (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
        const chainState = loadContinuationChainState(tailEntry, turnTokens);
        const dispatchResult = await dispatchToolDelegates({
          sessionKey,
          chainState,
          ctx: {
            sessionKey,
            agentChannel: queued.originatingChannel ?? undefined,
            agentAccountId: queued.originatingAccountId ?? undefined,
            agentTo: queued.originatingTo ?? undefined,
            agentThreadId: queued.originatingThreadId ?? undefined,
          },
          maxChainLength: resolveLiveContinuationRuntimeConfig(runtimeConfig).maxChainLength,
          // Hedge re-arm must see fresh chain state.
          loadFreshChainState: () => loadContinuationChainState(tailEntry, 0),
        });
        // Persist the advanced chain state back to the session
        // entry after dispatch. Without this the followup-path counter never
        // advances and `maxChainLength` enforcement breaks across hops.
        //
        // Persist even when `dispatched === 0`. The chainState
        // returned from `dispatchToolDelegates` carries the fresh
        // `accumulatedChainTokens` from `loadContinuationChainState(tailEntry,
        // turnTokens)` regardless of whether any delegate spawned. Guarding on
        // `dispatched > 0` drops the token total on followup-only chains
        // (delayed-only delegates, all-deferred dispatches, or pure
        // continue_work turns), causing token-budget drift across hops.
        if (dispatchResult && tailEntry) {
          persistContinuationChainState({
            sessionEntry: tailEntry,
            count: dispatchResult.chainState.currentChainCount,
            startedAt: dispatchResult.chainState.chainStartedAt,
            tokens: dispatchResult.chainState.accumulatedChainTokens,
          });
          // The in-memory mutation above is orphaned for disk. The followup
          // path's only durable writer is `persistRunSessionUsage`
          // → `updateSessionStoreEntry`, which `loadSessionStore(...,
          // skipCache: true)` and patches usage fields only —
          // `continuationChain*` is not in that patch shape. Without an
          // explicit `updateSessionStore` call the followup-only token chain
          // never reaches disk; cost-cap and `maxChainLength` enforcement
          // see stale values across cache eviction or gateway restart.
          //
          // Mirror agent-runner's explicit `updateSessionStore` with
          // `resolveSessionStoreEntry`
          // legacy-key cleanup so the chain fields land alongside the
          // disk-canonical entry.
          if (storePath && sessionKey) {
            try {
              await updateSessionStore(storePath, (store) => {
                const resolved = resolveSessionStoreEntry({ store, sessionKey });
                if (resolved.existing) {
                  store[resolved.normalizedKey] = {
                    ...resolved.existing,
                    continuationChainCount: dispatchResult.chainState.currentChainCount,
                    continuationChainStartedAt: dispatchResult.chainState.chainStartedAt,
                    continuationChainTokens: dispatchResult.chainState.accumulatedChainTokens,
                  };
                  for (const legacyKey of resolved.legacyKeys) {
                    delete store[legacyKey];
                  }
                }
              });
            } catch (err) {
              // Mirror agent-runner.ts's defensive log: persistence failure
              // must not break the followup reply itself.
              defaultRuntime.error?.(
                `[followup-runner] failed to persist continuation chain state for ${sessionKey}: ${String(err)}`,
              );
            }
          }
        }
      }

      // --- continue_work processing (#746) ---
      // When the agent calls continue_work during this followup turn, schedule
      // a delayed heartbeat for the session (same mechanism as agent-runner.ts).
      // This enables subagent/organ sessions to self-elect another turn.
      if (
        attemptContinueWorkRequest &&
        runtimeConfig?.agents?.defaults?.continuation?.enabled === true &&
        sessionKey
      ) {
        const { resolveLiveContinuationRuntimeConfig } = await import("../continuation/config.js");
        const continuationConfig = resolveLiveContinuationRuntimeConfig(runtimeConfig);
        const { maxChainLength, minDelayMs, maxDelayMs, defaultDelayMs } = continuationConfig;

        // Load chain state to check cap.
        const { loadContinuationChainState, persistContinuationChainState } =
          await import("../continuation/state.js");
        const tailUsage = runResult.meta?.agentMeta?.usage;
        const turnTokens = (tailUsage?.input ?? 0) + (tailUsage?.output ?? 0);
        const tailEntry = (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
        const chainState = loadContinuationChainState(tailEntry, turnTokens);
        const currentChainCount = chainState.currentChainCount;

        if (currentChainCount >= maxChainLength) {
          defaultRuntime.log(
            `[followup-runner] continue_work cap reached for ${sessionKey}: ` +
              `${currentChainCount}/${maxChainLength}`,
          );
        } else {
          const nextChainCount = currentChainCount + 1;
          const requestedDelayMs = attemptContinueWorkRequest.delaySeconds * 1000;
          const clampedDelay = Math.max(
            minDelayMs,
            Math.min(maxDelayMs, requestedDelayMs || defaultDelayMs),
          );

          // Persist advanced chain state.
          persistContinuationChainState({
            sessionEntry: tailEntry,
            count: nextChainCount,
            startedAt: chainState.chainStartedAt,
            tokens: chainState.accumulatedChainTokens,
          });

          // Schedule the continuation timer.
          retainContinuationTimerRef(sessionKey);
          const timerHandle = setTimeout(() => {
            try {
              defaultRuntime.log(
                `[followup-runner] continue_work timer fired for session ${sessionKey}`,
              );
              enqueueSystemEvent(
                `[continuation:wake] Turn ${nextChainCount}/${maxChainLength}. ` +
                  `The agent elected to continue working.` +
                  (attemptContinueWorkRequest!.reason
                    ? ` Reason: ${attemptContinueWorkRequest!.reason}`
                    : ""),
                { sessionKey, trusted: true },
              );
              requestHeartbeatNow({
                sessionKey,
                reason: "continuation",
                parentRunId: runId,
              });
            } finally {
              unregisterContinuationTimerHandle(sessionKey, timerHandle);
            }
          }, clampedDelay);
          registerContinuationTimerHandle(sessionKey, timerHandle);
          timerHandle.unref();
        }
      }

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const providerUsed =
        runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? queued.run.provider;
      const contextTokensUsed =
        resolveContextTokensForModel({
          cfg: queued.run.config,
          provider: providerUsed,
          model: modelUsed,
          contextTokensOverride: agentCfgContextTokens,
          fallbackContextTokens: activeSessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS;

      if (storePath && replySessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey: replySessionKey,
          cfg: runtimeConfig,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          promptTokens,
          isHeartbeat: opts?.isHeartbeat === true,
          modelUsed,
          providerUsed,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) {
        return;
      }
      const finalPayloads = resolveFollowupDeliveryPayloads({
        cfg: runtimeConfig,
        payloads: payloadArray,
        messageProvider: run.messageProvider,
        originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
        originatingChannel: queued.originatingChannel,
        originatingChatType: queued.originatingChatType,
        originatingTo: queued.originatingTo,
        sentMediaUrls: runResult.messagingToolSentMediaUrls,
        sentTargets: runResult.messagingToolSentTargets,
        sentTexts: runResult.messagingToolSentTexts,
      });

      if (finalPayloads.length === 0) {
        return;
      }

      let deliveryPayloads = finalPayloads;
      if (autoCompactionCount > 0) {
        const previousSessionId = run.sessionId;
        const count = await incrementRunCompactionCount({
          cfg: runtimeConfig,
          sessionEntry: activeSessionEntry,
          sessionStore,
          sessionKey: replySessionKey,
          storePath,
          amount: autoCompactionCount,
          compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
          newSessionId: runResult.meta?.agentMeta?.sessionId,
          newSessionFile: runResult.meta?.agentMeta?.sessionFile,
        });
        const refreshedSessionEntry =
          replySessionKey && sessionStore ? sessionStore[replySessionKey] : undefined;
        if (refreshedSessionEntry) {
          const queueKey = run.sessionKey ?? sessionKey;
          if (queueKey) {
            refreshQueuedFollowupSession({
              key: queueKey,
              previousSessionId,
              nextSessionId: refreshedSessionEntry.sessionId,
              nextSessionFile: refreshedSessionEntry.sessionFile,
            });
          }
        }
        if (run.verboseLevel && run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          deliveryPayloads = [
            {
              text: `🧹 Auto-compaction complete${suffix}.`,
            },
            ...finalPayloads,
          ];
        }
      }

      if (run.sourceReplyDeliveryMode === "message_tool_only") {
        logVerbose(
          "followup queue: automatic source delivery suppressed by sourceReplyDeliveryMode: message_tool_only",
        );
        return;
      }

      await sendFollowupPayloads(deliveryPayloads, effectiveQueued, {
        provider: providerUsed,
        modelId: modelUsed,
      });
    } finally {
      for (const end of endDeliveryCorrelations.toReversed()) {
        try {
          end();
        } catch (err) {
          defaultRuntime.error?.(
            `followup queue: delivery correlation cleanup failed: ${formatErrorMessage(err)}`,
          );
        }
      }
      completeFollowupRunLifecycle(queued);
      replyOperation?.complete();
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // buffered dispatcher's finally block, but followup turns bypass the
      // dispatcher entirely — so we must fire both signals here.  Without
      // this, NO_REPLY / empty-payload followups leave the typing indicator
      // stuck (the keepalive loop keeps sending "typing" to Telegram
      // indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
}
