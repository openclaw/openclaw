import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { clearAutoFallbackPrimaryProbeSelection } from "../../agents/agent-scope.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { hasResolvedThinkingCatalogEntry } from "../../agents/thinking-runtime.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionStorePathCore,
} from "../../config/sessions/paths.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import { replyRunInterruptTargetOperation } from "../../sessions/session-controller.contracts.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  getSessionControllerOperation,
  interruptReplyRunTarget,
  waitForReplyOperationOwnerSettlement,
} from "../../sessions/session-controller.js";
import { interruptSessionControllerEffects } from "../../sessions/session-controller.lifecycle.js";
import {
  updateSessionControllerSourcePolicy,
  bindSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { waitForCapturedSessionNativeAttemptEnd } from "../../sessions/session-controller.native-runtime.js";
import {
  getReplyOperationSessionReader,
  getSessionControllerEntryForOperation,
} from "../../sessions/session-controller.state.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  resolveThinkingSelectionForModel,
} from "../thinking.js";
import { removeDirectiveSpan } from "./directive-parsing.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import {
  finishReplyPreparation,
  loadAgentRunnerRuntime,
  loadEmbeddedAgentRuntime,
  loadSessionUpdatesRuntime,
  routeThreadIdsMatch,
} from "./get-reply-run-helpers.js";
import {
  REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
  waitForPreparedReplyQueue,
} from "./get-reply-run-queue.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { hasPendingFollowupQueueWork } from "./queue/state.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import {
  isSlackDirectRoutedThreadTurn,
  resolveRoutedDeliveryThreadId,
} from "./routed-delivery-thread.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { getReplySystemEventContext } from "./system-event-session-key.js";

export async function prepareReplyRunAdmission(context: PreparedReplyRunContext) {
  const {
    params,
    traceRunPhase,
    inboundEventKind,
    useFastReplyRuntime,
    thinkingRuntime,
    isFirstTurnInSession,
    isMainSession,
    effectiveQueueMode,
    effectiveResetTriggered,
    explicitThinkingLevelOverride,
    refreshInboundContextAfterAdmissionWait,
  } = context;
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    directives,
    modelState,
    provider,
    model,
    perMessageQueueOptions,
    typing,
    opts,
    isNewSession,
    sessionKey,
    sessionId,
    storePath,
    sessionEntryHandle,
    sessionStore,
  } = params;
  const assertPreparationActive = composeSessionSourceAssertion(
    [opts?.operatorAuthority?.assertCurrent, opts?.internalEventExecution?.assertCurrent],
    (assertSourceCurrent) => {
      opts?.abortSignal?.throwIfAborted();
      opts?.replyOperation?.abortSignal.throwIfAborted();
      assertSourceCurrent();
      if (opts?.replyOperation?.result) {
        throw new Error("Reply operation ended during preparation");
      }
    },
  );
  let { sessionEntry, prefixedBodyBase } = context;
  const isRoomEvent = inboundEventKind === "room_event";
  const sourceInput = readReplySourceInput(opts);
  const target =
    !sourceInput && sessionKey
      ? captureSessionTarget({
          storeScope: storePath ?? resolveSessionStorePathCore(cfg.session?.store, { agentId }),
          sessionKey,
          agentId,
        })
      : undefined;
  const resolveControllerOwner = () => {
    if (sourceInput) {
      return sourceInput.mailbox.owner;
    }
    const operation = sessionKey ? getSessionControllerOperation(sessionKey, target) : undefined;
    return operation ? getSessionControllerEntryForOperation(operation) : undefined;
  };
  const resolvedQueue =
    sourceInput?.policy ??
    (useFastReplyRuntime
      ? { mode: "collect" as const, debounceMs: 0, cap: 1, dropPolicy: "summarize" as const }
      : resolveQueueSettings({
          cfg,
          channel: sessionCtx.Provider,
          sessionEntry,
          inlineMode: effectiveQueueMode,
          inlineOptions: perMessageQueueOptions,
        }));
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;
  const prioritySource =
    activeRunQueueMode === "interrupt" && !context.isHeartbeat && !isRoomEvent
      ? sourceInput
      : undefined;
  // Priority precedes runtime loading and every abort/settlement await. It is
  // the same source captured at ingress, never a second interrupt-only input.
  if (sourceInput) {
    updateSessionControllerSourcePolicy(sourceInput, {
      ...resolvedQueue,
      mode: context.isHeartbeat || isRoomEvent ? "followup" : activeRunQueueMode,
    });
  }
  // Keep the physical owner through preparation; IDs can overlap across stores.
  const capturedOwner = resolveControllerOwner();
  const capturedInterruptOperation = capturedOwner?.active;
  const capturedNativeAttachment = capturedOwner?.attachment;
  const capturedNativeAttempt =
    capturedNativeAttachment && "handle" in capturedNativeAttachment
      ? capturedNativeAttachment
      : undefined;
  const activeRunInterruptTarget =
    activeRunQueueMode === "interrupt" &&
    !context.isHeartbeat &&
    !isRoomEvent &&
    capturedInterruptOperation &&
    capturedInterruptOperation !== opts?.replyOperation
      ? { [replyRunInterruptTargetOperation]: capturedInterruptOperation }
      : undefined;
  let { resolvedThinkLevel } = params;
  let thinkLevelOverride =
    explicitThinkingLevelOverride ??
    directives.thinkLevel ??
    (directives.clearThinkLevel ? ("default" as const) : undefined);

  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes the first token and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const firstToken = prefixedBodyBase.split(/\s+/, 1)[0] ?? "";
    const maybeLevel = normalizeThinkLevel(firstToken);
    const thinkingCatalog = maybeLevel
      ? await traceRunPhase("reply.resolve_thinking_catalog_for_hint", () =>
          modelState.resolveThinkingCatalog({ provider, model }),
        )
      : undefined;
    if (
      maybeLevel &&
      isThinkingLevelSupported({
        provider,
        model,
        level: maybeLevel,
        catalog: thinkingCatalog,
        agentRuntime: thinkingRuntime,
      })
    ) {
      resolvedThinkLevel = maybeLevel;
      thinkLevelOverride = maybeLevel;
      prefixedBodyBase = removeDirectiveSpan(prefixedBodyBase, 0, firstToken.length);
    }
  }
  const threadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);
  const threadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : !isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const drainedSystemEventBlocks: string[] = [];
  const drainSystemEventBlocks = async () => {
    if (useFastReplyRuntime) {
      return;
    }
    const eventContext = getReplySystemEventContext(opts);
    const routeSystemEventSessionKey = normalizeOptionalString(eventContext?.sessionKey);
    const systemEventSessionKeys = context.isHeartbeat
      ? [routeSystemEventSessionKey ?? sessionKey]
      : routeSystemEventSessionKey && routeSystemEventSessionKey !== sessionKey
        ? [routeSystemEventSessionKey, sessionKey]
        : [sessionKey];
    for (const systemEventSessionKey of systemEventSessionKeys) {
      if (systemEventSessionKey === undefined) {
        continue;
      }
      const isCurrentSession = systemEventSessionKey === sessionKey;
      assertPreparationActive();
      const eventsBlock = await drainFormattedSystemEvents({
        cfg,
        agentId,
        sessionKey: systemEventSessionKey,
        isMainSession: isCurrentSession && isMainSession,
        isNewSession: isCurrentSession && isNewSession,
        // Producer-owned turns consume only their captured occurrence selection.
        events:
          context.isHeartbeat || opts?.internalEventExecution
            ? (eventContext?.events ?? [])
            : undefined,
        deferredEventIds: context.isHeartbeat ? eventContext?.deferredEventIds : undefined,
        onEventsAdmitted: context.isHeartbeat ? eventContext?.onEventsAdmitted : undefined,
      });
      if (eventsBlock) {
        drainedSystemEventBlocks.push(eventsBlock);
      }
    }
  };
  const rebuildPromptBodies = () =>
    traceRunPhase("reply.build_prompt_bodies", () =>
      context.buildPromptBodies({
        prefixedBody: prefixedBodyBase,
        threadContextNote,
        systemEventBlocks: drainedSystemEventBlocks,
        media: opts?.media,
      }),
    );
  const skillResult = isFastTestRuntimeEnv()
    ? {
        sessionEntry,
        skillsSnapshot: sessionEntry?.skillsSnapshot,
      }
    : await traceRunPhase("reply.ensure_skill_snapshot", async () => {
        const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
        return await ensureSkillSnapshot({
          agentId,
          // Command continuations prepare the target before adopting its run slot below.
          reader:
            opts?.replyOperation && opts.replyOperation.key === sessionKey
              ? getReplyOperationSessionReader(opts.replyOperation)
              : undefined,
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          storePath,
          sessionId,
          isFirstTurnInSession,
          workspaceDir: context.skillsWorkspaceDir,
          executionWorkspaceDir: context.workspaceDir,
          cfg,
          execOverrides: params.execOverrides,
          skillFilter: opts?.skillFilter,
          skillOverrides: opts?.skillOverrides,
          assertCurrent: assertPreparationActive,
        });
      });
  sessionEntry = skillResult.sessionEntry;
  if (sessionEntry) {
    sessionEntryHandle?.replaceCurrent(sessionEntry);
  }
  const skillsSnapshot = skillResult.skillsSnapshot;
  let promptBodies = await rebuildPromptBodies();
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await traceRunPhase("reply.resolve_default_thinking", () =>
      modelState.resolveDefaultThinkingLevel({ provider, model, agentRuntime: thinkingRuntime }),
    );
  }
  const allowedThinkingCatalog = modelState.allowedModelCatalog ?? [];
  let thinkingCatalog = allowedThinkingCatalog.length > 0 ? allowedThinkingCatalog : undefined;
  const resolveCurrentThinkingSelection = () =>
    resolveThinkingSelectionForModel({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
  let thinkingSelection = resolveCurrentThinkingSelection();
  const shouldHydrateThinkingCatalog =
    !thinkingSelection.supported ||
    (resolvedThinkLevel !== "off" &&
      !hasResolvedThinkingCatalogEntry({ catalog: thinkingCatalog, provider, model }));
  if (shouldHydrateThinkingCatalog) {
    // Hydrate the runtime model catalog only when the lightweight catalog cannot
    // prove support or lacks reasoning metadata for the selected model. The full
    // catalog load was a 14s+ reply-blocking cost for known Codex models that
    // already publish authoritative thinking metadata.
    thinkingCatalog = await traceRunPhase("reply.resolve_thinking_catalog", () =>
      modelState.resolveThinkingCatalog({ provider, model }),
    );
    thinkingSelection = resolveCurrentThinkingSelection();
  }
  if (!thinkingSelection.supported) {
    const explicitThink =
      (directives.hasThinkDirective && directives.thinkLevel !== undefined) ||
      explicitThinkingLevelOverride !== undefined;
    if (explicitThink) {
      return finishReplyPreparation(typing, () => ({
        text: `Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
      }));
    }
  }

  const providedReplyOperation = opts?.replyOperation;
  const isProvidedOperationQueued = () =>
    providedReplyOperation?.result === null && providedReplyOperation.phase === "queued";
  // Command continuations move their unclaimed source before context preparation.
  const rebindProvidedReplyOperation = (nextSessionId: string) => {
    if (
      providedReplyOperation !== undefined &&
      isProvidedOperationQueued() &&
      nextSessionId !== providedReplyOperation.sessionId
    ) {
      // Dispatch can reserve a queued operation before session init discovers the
      // authoritative row. Keep steer/abort and durable admission on that session.
      providedReplyOperation.updateSessionId(nextSessionId);
    }
  };
  const sessionIdFinal = sessionId ?? providedReplyOperation?.sessionId ?? crypto.randomUUID();
  const sessionFilePathOptions = resolveSessionFilePathOptions({ agentId, storePath });
  const resolvePreparedSessionState = (): {
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionFile: string;
  } => {
    // Admission and in-process publications own this turn’s working entry.
    const latestSessionEntry =
      sessionStore && sessionKey ? (sessionStore[sessionKey] ?? sessionEntry) : sessionEntry;
    const latestSessionId = latestSessionEntry?.sessionId ?? sessionIdFinal;
    rebindProvidedReplyOperation(latestSessionId);
    opts?.onSessionPrepared?.({
      sessionKey,
      sessionId: latestSessionId,
      lifecycleRevision: latestSessionEntry?.lifecycleRevision,
      storePath,
    });
    // Queued admission uses the scoped key too. A legacy marker for the same
    // transcript would make unchanged tool authority fail the steering check.
    const sessionFile =
      normalizeOptionalString(sessionKey) ??
      (storePath
        ? formatSqliteSessionFileMarker({ agentId, sessionId: latestSessionId, storePath })
        : resolveSessionFilePathCore(latestSessionId, latestSessionEntry, sessionFilePathOptions));
    return { sessionEntry: latestSessionEntry, sessionId: latestSessionId, sessionFile };
  };
  let preparedSessionState = resolvePreparedSessionState();
  const queueKey = sessionKey ?? sessionIdFinal;
  const embeddedAgentRuntime = useFastReplyRuntime
    ? null
    : await traceRunPhase("reply.load_embedded_agent_runtime", () => loadEmbeddedAgentRuntime());
  const resolveSessionlessNativeAttachment = () =>
    !sourceInput && !sessionKey
      ? embeddedAgentRuntime?.resolveActiveEmbeddedRunBySessionFile(
          preparedSessionState.sessionFile,
        )
      : undefined;
  const rawActiveSessionIdForInterrupt =
    capturedNativeAttempt?.operation.sessionId ?? resolveSessionlessNativeAttachment()?.sessionId;
  const shouldPreemptHeartbeat =
    !isRoomEvent && !context.isHeartbeat && rawActiveSessionIdForInterrupt !== undefined;
  assertPreparationActive();
  const heartbeatPreemption =
    sourceInput || sessionKey
      ? await (async () => {
          if (
            !shouldPreemptHeartbeat ||
            !capturedNativeAttempt?.handle.preemptByVisibleTurn ||
            resolveControllerOwner()?.attachment !== capturedNativeAttachment ||
            capturedOwner?.active !== capturedNativeAttempt.operation
          ) {
            return "not-heartbeat";
          }
          assertPreparationActive();
          try {
            if (!capturedNativeAttempt.handle.preemptByVisibleTurn()) {
              return "not-heartbeat";
            }
          } catch (error) {
            if (sourceInput) {
              throw error;
            }
            diag.warn(
              `heartbeat preemption failed: sessionId=${capturedNativeAttempt.operation.sessionId} err=${String(error)}`,
            );
          } finally {
            if (!sourceInput) {
              notifyGatewayWorkMetricsChanged();
            }
          }
          const [nativeSettled, ownerSettled] = await Promise.all([
            waitForCapturedSessionNativeAttemptEnd(
              capturedNativeAttempt.sessionId,
              REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
              capturedNativeAttempt,
            ),
            waitForReplyOperationOwnerSettlement(
              capturedNativeAttempt.operation,
              REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            ),
          ]);
          return nativeSettled && ownerSettled ? "drained" : "timed-out";
        })()
      : shouldPreemptHeartbeat && embeddedAgentRuntime
        ? await embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun(
            rawActiveSessionIdForInterrupt,
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          )
        : "not-heartbeat";
  if (heartbeatPreemption === "timed-out") {
    if (prioritySource) {
      retireSessionControllerInput(prioritySource);
    }
    typing.cleanup();
    return {
      kind: "reply",
      reply: { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT },
    } as const;
  }
  const visibleTurnPreemptsHeartbeat = heartbeatPreemption === "drained";
  const resolveRuntimeAuthProfile = async () => {
    if (useFastReplyRuntime && !params.configuredProfileId && !modelState.operatorModelOverride) {
      return {
        authProfileId: preparedSessionState.sessionEntry?.authProfileOverride,
        authProfileIdSource: resolveCollapsedSessionAuthPinSource(
          preparedSessionState.sessionEntry,
        ),
      };
    }
    const shouldUseEphemeralSession =
      params.autoFallbackPrimaryProbe !== undefined ||
      params.configuredProfileId !== undefined ||
      modelState.operatorModelOverride === true;
    const authSessionKey = shouldUseEphemeralSession ? (sessionKey ?? sessionIdFinal) : sessionKey;
    const authSessionEntry = preparedSessionState.sessionEntry
      ? { ...preparedSessionState.sessionEntry }
      : undefined;
    if (params.autoFallbackPrimaryProbe && authSessionEntry) {
      clearAutoFallbackPrimaryProbeSelection(authSessionEntry);
    }
    const authSessionStore =
      shouldUseEphemeralSession && authSessionEntry && authSessionKey !== undefined
        ? { [authSessionKey]: authSessionEntry }
        : sessionStore;
    if (authSessionStore && authSessionEntry && authSessionKey !== undefined) {
      authSessionStore[authSessionKey] = authSessionEntry;
    }
    const selection = await resolveSessionAuthSelection({
      cfg,
      provider,
      modelId: model,
      agentId,
      configuredProfileId: params.configuredProfileId,
      agentDir,
      reader:
        providedReplyOperation?.key === authSessionKey
          ? getReplyOperationSessionReader(providedReplyOperation)
          : undefined,
      sessionEntry: authSessionEntry,
      sessionStore: authSessionStore,
      sessionKey: authSessionKey,
      storePath: shouldUseEphemeralSession ? undefined : storePath,
      isNewSession,
      assertCommitAllowed: assertPreparationActive,
      // Only an authenticated Gateway profile establishes a person-linked pin;
      // channel senders read as observations and resolve to undefined here.
      requesterProfileId: readSessionInputProfileId(ctx),
    });
    return {
      authProfileId: selection?.profileId,
      authProfileIdSource: selection?.source,
    };
  };
  let { authProfileId, authProfileIdSource } = await traceRunPhase(
    "reply.resolve_auth_profile",
    () => resolveRuntimeAuthProfile(),
  );
  const { runReplyAgent } = await traceRunPhase("reply.load_agent_runner_runtime", () =>
    loadAgentRunnerRuntime(),
  );

  preparedSessionState = resolvePreparedSessionState();
  const currentRouteThreadId = resolveRoutedDeliveryThreadId({ ctx, sessionKey });
  const applySlackRouteThreadSteeringGuard = isSlackDirectRoutedThreadTurn(ctx);
  const resolveQueueBusyState = () => {
    const owner = resolveControllerOwner();
    const activeOperation = owner?.active;
    const attachment = owner?.attachment;
    const nativeAttachment =
      activeOperation &&
      attachment &&
      "handle" in attachment &&
      attachment.operation === activeOperation
        ? attachment
        : resolveSessionlessNativeAttachment();
    const activeSessionId = activeOperation?.sessionId ?? nativeAttachment?.sessionId;
    const isOwnPreDispatchOperation =
      activeOperation !== undefined &&
      activeOperation === providedReplyOperation &&
      isProvidedOperationQueued();
    return {
      activeSessionId,
      activeOperation,
      isActive: !isOwnPreDispatchOperation && Boolean(activeOperation || nativeAttachment),
      nativeAttachment,
      terminalProducerBlocked: activeOperation?.terminalProducerBlocked,
    };
  };
  const { activeSessionId, activeOperation, isActive, nativeAttachment } = resolveQueueBusyState();
  const hasQueuedFollowups =
    sourceInput?.claim?.operation === providedReplyOperation && providedReplyOperation
      ? false
      : sourceInput
        ? sourceInput.mailbox.entries.some(
            (entry) => entry !== sourceInput && entry.phase !== "consumed",
          ) || sourceInput.mailbox.droppedCount > 0
        : hasPendingFollowupQueueWork([queueKey], target);
  const activeRunAcceptsCurrentThread =
    !isActive ||
    !sessionKey ||
    !applySlackRouteThreadSteeringGuard ||
    routeThreadIdsMatch(activeOperation?.routeThreadId, currentRouteThreadId);

  const shouldSteer =
    !isRoomEvent &&
    activeRunAcceptsCurrentThread &&
    !context.isHeartbeat &&
    !effectiveResetTriggered &&
    !visibleTurnPreemptsHeartbeat &&
    resolvedQueue.mode === "steer";
  const shouldFollowup =
    !effectiveResetTriggered &&
    !visibleTurnPreemptsHeartbeat &&
    ((isRoomEvent && isActive) ||
      resolvedQueue.mode === "steer" ||
      resolvedQueue.mode === "followup" ||
      resolvedQueue.mode === "collect");
  const activeRunQueueAction = resolveActiveRunQueueAction({
    hasQueuedFollowups,
    interrupt: activeRunQueueMode === "interrupt" && !isRoomEvent,
    isActive,
    isHeartbeat: context.isHeartbeat,
    shouldFollowup,
    resetTriggered: effectiveResetTriggered,
  });
  if (isActive && activeRunQueueAction === "run-now") {
    const queueReply = await waitForPreparedReplyQueue({
      activeSessionId: activeSessionId ?? preparedSessionState.sessionId,
      queueMode: activeRunQueueMode,
      interruptActiveRun: async () => {
        assertPreparationActive();
        if (activeRunInterruptTarget) {
          const captured = activeRunInterruptTarget[replyRunInterruptTargetOperation];
          const outcome = await interruptReplyRunTarget(
            activeRunInterruptTarget,
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          );
          if (!outcome.aborted && !outcome.settled) {
            // Finishing cannot be aborted. Keep the reserved newest successor until
            // this exact owner settles, rather than letting older backlog leapfrog.
            await racePromiseWithAbortSignal(captured.ownerSettlement, opts?.abortSignal);
            return true;
          }
          return outcome.settled;
        }
        // A source captured with no operation cannot cancel an owner installed
        // while preparation awaited. The legacy sessionless adapter alone uses
        // its physical effect scope.
        if (sourceInput || sessionKey || !storePath) {
          return false;
        }
        const interrupted = await interruptSessionControllerEffects({
          scope: storePath,
          identities: [sessionKey, activeSessionId, preparedSessionState.sessionId],
          timeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
        });
        return (
          interrupted &&
          (await waitForCapturedSessionNativeAttemptEnd(
            activeSessionId ?? preparedSessionState.sessionId,
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            nativeAttachment,
          ))
        );
      },
      waitForActiveRunEnd: (activeRunSessionId) =>
        Promise.all([
          waitForCapturedSessionNativeAttemptEnd(
            activeRunSessionId,
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            nativeAttachment,
          ),
          activeOperation &&
            waitForReplyOperationOwnerSettlement(activeOperation, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS),
        ]),
      refreshPreparedState: async () => {
        preparedSessionState = resolvePreparedSessionState();
        ({ authProfileId, authProfileIdSource } = await resolveRuntimeAuthProfile());
        preparedSessionState = resolvePreparedSessionState();
        // The interrupted run may have changed goal or suggestion state while admission waited.
        refreshInboundContextAfterAdmissionWait();
        promptBodies = await rebuildPromptBodies();
      },
      resolveBusyState: resolveQueueBusyState,
    });
    if (queueReply) {
      if (prioritySource) {
        retireSessionControllerInput(prioritySource);
      }
      typing.cleanup();
      return { kind: "reply", reply: queueReply } as const;
    }
  }
  if (activeRunQueueAction !== "drop") {
    await traceRunPhase("reply.drain_system_events", () => drainSystemEventBlocks());
    promptBodies = await rebuildPromptBodies();
  }

  return {
    kind: "ready",
    context,
    resolvedThinkLevel,
    thinkLevelOverride,
    thinkingCatalog,
    skillsSnapshot,
    promptBodies,
    isRoomEvent,
    providedReplyOperation,
    preparedSessionState,
    resolvedQueue,
    isRunActive: async () => {
      preparedSessionState = resolvePreparedSessionState();
      return Boolean(
        embeddedAgentRuntime &&
        (resolveControllerOwner()?.active || resolveSessionlessNativeAttachment()),
      );
    },
    runReplyAgent: sourceInput
      ? (input: Parameters<typeof runReplyAgent>[0]) => {
          bindSessionControllerSource(sourceInput, input.followupRun);
          return runReplyAgent(input);
        }
      : runReplyAgent,
    queueKey,
    shouldSteer,
    shouldFollowup,
    hasQueuedFollowups,
    isActive,
    authProfileId,
    authProfileIdSource,
  } as const;
}

export type PreparedReplyRunAdmission = Extract<
  Awaited<ReturnType<typeof prepareReplyRunAdmission>>,
  { kind: "ready" }
>;
