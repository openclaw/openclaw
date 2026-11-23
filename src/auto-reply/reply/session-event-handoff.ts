import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { FAILOVER_REASONS } from "../../agents/failover/signal.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import { hasInternalHookListeners } from "../../hooks/internal-hooks.js";
import { isOperatorAuthorityUnavailable } from "../../infra/operator-authority-error.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { chatRef } from "../../sessions/chat-ref.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { settleUserTurnPendingInput } from "../../sessions/user-turn-transcript-processing.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import {
  prepareCronRunContinuationCleanup,
  prepareScheduledAutomationStart,
  resolveSessionEventReplyOptions,
  settleSessionEventTurn,
  withScheduledSessionProviderAdmission,
  type ScheduledAutomationAdmission,
} from "./session-event-automation.js";
import {
  buildSessionEventContext,
  prepareSessionEventOccurrence,
  stageSessionEventInput,
} from "./session-event-context.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";
import { createSessionEventReplyDelivery } from "./session-event-delivery.js";
import { narrowSessionEventSettings } from "./session-event-policy.js";
import {
  assertSessionEventTargetCurrent,
  assertSessionEventSettingsCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
  hasSessionEventOriginatingCaller,
  readSessionEventTargetOperatorAuthority,
  intersectSessionEventToolsAllow,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";
import {
  createSessionEventReadmission,
  resolveSessionEventTerminalOutcome,
  settleSessionEventAttempt,
  type SessionEventReadmission,
} from "./session-event-terminal.js";

export { assertSessionEventTargetCurrent, captureSessionEventTargetForHost };
export { combineSessionEventTargetsForHost } from "./session-event-target.js";
export type { SessionEventReceipt, SessionEventTarget } from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

// The loader exposes this synchronous facade; enter auth/plugin preparation only in admitted async work.
const loadTurnReadmission = createLazyRuntimeNamedExport(
  () => import("./queue/drain-admission-scope.js"),
  "runOutsideAdmittedTurnScopes",
);

/**
 * Producer-owned occurrence; passive notices continue to use enqueueSystemEvent.
 * Producers omit `retry`; only re-admission of the same occurrence passes it.
 */
export function enqueueSessionEventForHost(
  text: string,
  options: SessionEventOptions,
  retry: SessionEventReadmission = createSessionEventReadmission(),
): SessionEventReceipt {
  const input = prepareSessionEventOccurrence(text, options);
  const {
    cfg,
    agentId,
    sessionKey,
    env,
    storePath,
    operatorAuthority: capturedOperatorAuthority,
  } = input.context;
  let operatorAuthority = capturedOperatorAuthority;
  const { signal } = input;
  const occurrenceId = input.claim.occurrenceId;
  let acceptanceAssertion = input.acceptanceAssertion;
  const cleanupContinuation = prepareCronRunContinuationCleanup(sessionKey, storePath, env);
  let target = options.expectedTarget;
  let generationLease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
  let preparedBinding: { sessionId: string; lifecycleRevision?: string } | undefined;
  let route = input.route;
  let releaseOperatorAuthority = input.releaseOperatorAuthority;
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  const acceptance = createDeferredCore<Awaited<SessionEventReceipt["accepted"]>>();
  let accepted = false;
  let started = false;
  let admissionStarted = false;
  let deferred = false;
  let waitingProvider: string | undefined;
  const automationAdmission: ScheduledAutomationAdmission = { admissionDeferred: false };
  let adopted = false;
  // Queue-owner abandonment (lifecycle cleanup) stays terminal.
  let abandoned = false;
  // The live re-admission attempt; receipt.cancel forwards to it once it exists.
  let readmittedReceipt: SessionEventReceipt | undefined;
  let operation: ReplyOperation | undefined;
  let inputRecorder: UserTurnTranscriptRecorder | undefined;
  let conversationResultCommitted: true | undefined;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let failure: Error | string | undefined;
  // Placeholder text; the operation's recorded cause is more actionable when present.
  let genericFailure: string | undefined;
  let terminalOutcome: AgentRunTerminalOutcome | undefined;
  let errorReason: SessionEventOutcome["errorReason"];
  let nextCheckMs: number | undefined;
  let sourceDeliveryOutcome: SourceDeliveryOutcome | undefined;
  let automationResult: SessionEventOutcome["automationResult"];
  let settlement: "settling" | "finished" | undefined;
  let settings = options.expectedTarget?.settings;
  let checkedSettings: typeof settings | null = null;
  let isDeletionBlocked: (() => boolean) | undefined;
  const jobTools = options.scheduledAutomation
    ? resolveCronRunToolsAllow(options.scheduledAutomation.job)
    : undefined;
  const producerTools = options.expectedTarget?.toolsAllow;
  const toolsAllow = intersectSessionEventToolsAllow(jobTools, producerTools);
  const assertOwnerCurrent = () => {
    if (settlement === "finished") {
      throw new Error("Session event occurrence is settled");
    }
    signal.throwIfAborted();
    capturedOperatorAuthority?.assertCurrent();
    if (!accepted) {
      acceptanceAssertion?.();
    }
    options.assertCurrent?.();
    options.expectedTarget?.assertCurrent?.();
    const currentConfig = getSessionEventRuntimeConfig();
    resolveConfiguredAgentId(currentConfig, agentId);
    if (!isDeletionBlocked || isDeletionBlocked()) {
      throw new Error("Session event agent is being deleted");
    }
    options.scheduledAutomation?.assertCurrent();
    if (
      operation &&
      (operation.abortSignal.aborted || !isCurrentSessionControllerOperation(operation))
    ) {
      throw new Error("Session event admission no longer owns its destination");
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    if (checkedSettings !== null && generationLease) {
      const currentSettings = generationLease.readSessionSettings();
      if (currentSettings !== checkedSettings) {
        assertSessionEventSettingsCurrent(settings, currentSettings);
        checkedSettings = currentSettings;
      }
    } else {
      generationLease?.assertCurrent();
    }
  };
  const captureSources = () =>
    composeSessionSourceAssertion(
      [
        operatorAuthority?.assertCurrent,
        accepted ? undefined : acceptanceAssertion,
        options.assertCurrent,
        options.expectedTarget?.assertCurrent,
        options.scheduledAutomation?.assertCurrent,
        createDynamicSessionSourceAssertion(
          () => generationLease?.assertCurrent,
          () => {
            throw new Error("The session event destination changed. Start a new turn to retry.");
          },
        ),
      ],
      (assertSources) => {
        assertSources();
        assertCurrent();
      },
    );
  Object.assign(assertCurrent, {
    prepareSessionSourceEffect: () => captureSources().prepareSessionSourceEffect(),
    prepareSessionSourceStorageEffect: () => captureSources().prepareSessionSourceStorageEffect(),
  });
  const assertEffectCurrent = composeSessionSourceAssertion([assertCurrent], (assertSource) => {
    assertSource();
    input.configPolicy.assertCurrent(getSessionEventRuntimeConfig(), [
      route?.channel,
      target?.deliveryContext?.channel,
    ]);
  });
  const accept = () => {
    if (accepted || settlement === "finished") {
      return;
    }
    assertCurrent();
    accepted = true;
    acceptanceAssertion = undefined;
    acceptance.resolve({ ok: true });
  };
  const prepareCurrent = async () => {
    assertOwnerCurrent();
    if (operation && preparedBinding && operation.sessionId !== preparedBinding.sessionId) {
      const replacement = await captureSessionEventTargetForHost(agentId, sessionKey, {
        env,
        assertCurrent: assertOwnerCurrent,
      });
      if (replacement.sessionId !== operation.sessionId) {
        throw new Error("Session event reply owner lost its rotated destination");
      }
      const replacementLease = await prepareSessionEventTargetForHost(replacement);
      try {
        assertOwnerCurrent();
      } catch (error) {
        replacementLease.release();
        throw error;
      }
      generationLease?.release();
      generationLease = replacementLease;
      preparedBinding = replacement;
    }
    await options.scheduledAutomation?.prepare?.();
    for (let read = generationLease?.prepareRead(); read; read = generationLease?.prepareRead()) {
      await read;
    }
    assertCurrent();
  };
  const start = () => {
    assertCurrent();
    if (started) {
      return;
    }
    options.scheduledAutomation?.onStarted?.();
    input.claim.ownership.start();
    input.configPolicy.start();
    started = true;
    accept();
  };
  const prepareStart = async (runId?: string) => {
    await prepareCurrent();
    if (started) {
      return;
    }
    const startSignal = operation ? AbortSignal.any([signal, operation.abortSignal]) : signal;
    await prepareScheduledAutomationStart({
      automation: options.scheduledAutomation,
      operation: () => operation,
      signal: startSignal,
      prepareCurrent,
      admission: automationAdmission,
      // Registered bootstrap hooks can perform arbitrary work before native preparation
      // reports activity. Conservatively consume custody even if bootstrap is later skipped.
      onReady: runId && hasInternalHookListeners("agent", "bootstrap") ? start : undefined,
    });
  };
  const finish = () => {
    if (settlement) {
      return;
    }
    settlement = "settling";
    const complete = async () => {
      let inputSettled = true;
      try {
        await settleUserTurnPendingInput(
          inputRecorder,
          operation?.abortSignal ?? signal,
          failure,
          isDeletionBlocked?.(),
          "cancelled",
          accepted,
        );
      } catch (error) {
        inputSettled = false;
        failure ??= error instanceof Error ? error : String(error);
      }
      // Submitting custody ends at the first acceptance; a pre-acceptance re-admission
      // carries the still-live assertion so revoked ingress rejects the retry.
      const pendingAcceptanceAssertion = accepted ? undefined : acceptanceAssertion;
      acceptanceAssertion = undefined;
      const readmission = await settleSessionEventAttempt({
        text: input.claim.eventText,
        options: {
          ...options,
          agentId,
          sessionKey,
          occurrences: input.claim.occurrences,
          assertAcceptanceCurrent: pendingAcceptanceAssertion,
        },
        signal,
        occurrenceId,
        ownership: input.claim.ownership,
        retry,
        waitingProvider,
        facts: () => ({
          source: options.source,
          failure,
          configPolicy: input.configPolicy,
          inputSettled,
          accepted,
          adopted,
          started,
          conversationResultCommitted,
          delivery,
          abandoned,
        }),
        onSettling(error) {
          settlement = "finished";
          signal.removeEventListener("abort", onAbort);
          generationLease?.release();
          generationLease = undefined;
          return resolveSessionEventTerminalOutcome({
            operation,
            signal,
            failure: error ?? failure,
            genericFailure,
            terminalOutcome,
          });
        },
        enqueue: enqueueSessionEventForHost,
        log,
      });
      const { terminal, receipt } = readmission;
      readmittedReceipt = receipt;
      ({ terminalOutcome } = terminal);
      failure = readmission.failure ?? terminal.failure;
      releaseOperatorAuthority?.();
      if (!accepted) {
        acceptance.resolve(
          readmittedReceipt?.accepted ?? {
            ok: false,
            error: failure ? String(failure) : "Session event was cancelled before acceptance",
            cause: failure instanceof Error ? failure : undefined,
          },
        );
      }
      if (readmittedReceipt) {
        resolve(readmittedReceipt.settled);
        return;
      }
      const { status } = terminal;
      resolve({
        status,
        executionStarted: started,
        terminalOutcome,
        errorReason: status === "failed" ? errorReason : undefined,
        interruptedByRestart: terminalOutcome.stopReason === "restart",
        delivered: delivery.delivered,
        conversationResultCommitted,
        deliveryAttempted: delivery.deliveryAttempted,
        deliveryAmbiguous: delivery.deliveryAmbiguous,
        deliveryError: delivery.deliveryError,
        deliverySuppressionReason,
        admissionDeferredReason: !started ? automationAdmission.admissionDeferredReason : undefined,
        admissionDeferred:
          !started &&
          (automationAdmission.admissionDeferred ||
            (operation?.result?.kind === "aborted" &&
              operation.result.code === "aborted_for_supersession")),
        summary: delivery.summary,
        nextCheckMs,
        sourceDeliveryOutcome,
        automationResult,
        ...(failure ? { error: String(failure) } : {}),
        ...(failure instanceof SessionWorkStartError ? { retryable: failure.retryable } : {}),
        ...(!started && !signal.aborted && isOperatorAuthorityUnavailable(failure)
          ? { retryable: true }
          : {}),
      });
      cleanupContinuation?.();
    };
    if (operation?.ownerSettlement) {
      void operation.ownerSettlement.then(complete, complete);
    } else {
      void complete();
    }
  };
  const onAbort = () => {
    // Started admission owns native preparation and reply settlement, even before model start.
    if (!operation && !admissionStarted) {
      finish();
    }
  };
  const delivery = createSessionEventReplyDelivery({
    options,
    agentId,
    sessionKey,
    signal,
    target: () => target,
    route: () => route,
    prepareCurrent,
    assertCurrent,
    assertEffectCurrent,
    sourceReplyDelivered: () => sourceDeliveryOutcome?.satisfiesSourceDelivery === true,
  });
  const deliver = delivery.deliver;
  signal.addEventListener("abort", onAbort, { once: true });
  // Completion outlives the producer's request scope and transcript writer.
  // Keep detached work through settlement; explicit request/Stop signals above
  // still cancel the occurrence and join its native execution owner.
  const execute = async () => {
    await readAgentDeletionJournalStatusInWorker(agentId, { env }, signal);
    isDeletionBlocked = prepareAgentDeletionBlocked(agentId, { env });
    assertOwnerCurrent();
    const { dispatchInboundMessageWithRoutedChannelDispatcher } = await import("../dispatch.js");
    const { prepareChatLease } =
      await import("../../config/sessions/session-delivery-generation.js");
    target ??= await captureSessionEventTargetForHost(agentId, sessionKey, {
      env,
      assertCurrent: options.assertCurrent,
      assertCaptureCurrent: assertOwnerCurrent,
    });
    assertSessionEventTargetCurrent(target);
    if (!target.sessionId && !options.createIfMissing) {
      throw new Error("Session event origin is missing; start fresh authorized work instead");
    }
    generationLease = await prepareSessionEventTargetForHost(target, {
      createIfMissing: options.createIfMissing,
      assertAcceptanceCurrent: assertOwnerCurrent,
    });
    const admittedOperatorAuthority = readSessionEventTargetOperatorAuthority(target);
    if (admittedOperatorAuthority && admittedOperatorAuthority !== operatorAuthority) {
      const release = admittedOperatorAuthority.retain?.();
      releaseOperatorAuthority?.();
      releaseOperatorAuthority = release;
      operatorAuthority = admittedOperatorAuthority;
    }
    settings ??= target.settings;
    route ??= structuredClone(target.deliveryContext);
    await prepareCurrent();
    checkedSettings = generationLease.readSessionSettings();
    settings = narrowSessionEventSettings(settings, checkedSettings);
    const promptText = options.scheduledAutomation?.preparePrompt
      ? await options.scheduledAutomation.preparePrompt(cfg)
      : input.claim.eventText;
    assertEffectCurrent();
    const ctx = buildSessionEventContext({
      cfg,
      agentId,
      sessionKey,
      text: promptText,
      options,
      readmissionAttempt: retry.attempt,
      occurrenceId,
      deliveryContext: route,
      target,
      assertCurrent,
    });
    const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
      cfg: { ...cfg, session: { ...cfg.session, store: storePath } },
      ctx,
      dispatcherOptions: {
        deliver: (payload, info) => deliver(payload, info.kind),
        onError: (error) => {
          failure ??= error instanceof Error ? error : String(error);
        },
        onSkip: (_payload, info) => {
          if (info.kind === "final") {
            deliverySuppressionReason = info.reason;
          }
        },
      },
      replyOptions: {
        onModelSelected: options.scheduledAutomation
          ? (selection) => {
              input.configPolicy.selectModel(selection);
              assertEffectCurrent();
            }
          : undefined,
        sessionPrincipalTurn:
          !options.scheduledAutomation &&
          !isCronSessionKey(sessionKey) &&
          !hasSessionEventOriginatingCaller(target),
        scheduledAutomation: withScheduledSessionProviderAdmission(
          options.scheduledAutomation,
          (provider) => {
            waitingProvider = provider;
          },
        ),
        ...resolveSessionEventReplyOptions(options),
        operatorAuthority: options.scheduledAutomation?.operatorAuthority ?? operatorAuthority,
        admittedSessionSettings: settings,
        toolsAllow,
        onDeliberateSilentTerminalReply: () => {
          deliverySuppressionReason = "silent";
        },
        abortSignal: signal,
        expectedExistingSessionId: target.sessionId || undefined,
        pinExpectedExistingSession: Boolean(target.sessionId),
        onSessionPrepared: (binding) => {
          if (binding.sessionKey === sessionKey) {
            preparedBinding = binding;
          }
        },
        queueModeOverride: "followup",
        suppressTyping: true,
        typingPolicy: "system_event",
        onReplyOperationAdmitted: (owned) => {
          operation = owned;
        },
        internalEventExecution: {
          // The admitted source authorizes board writes, not a disconnected inline renderer.
          pinnedWidgetAuthoring:
            options.source === "restart" && operatorAuthority ? true : undefined,
          prepareInput: async (recorder) => {
            inputRecorder = recorder;
            await stageSessionEventInput(recorder, occurrenceId, assertCurrent, retry.attempt);
          },
          execRequestOwners: input.execRequestOwners,
          deliver: options.deliver === false || target.deliver === false ? false : undefined,
          assertCurrent: assertEffectCurrent,
          ...(target.sessionId === "" && options.createIfMissing
            ? {
                bindSessionCreation: (creation: SessionEntryCreationOperation) => {
                  assertOwnerCurrent();
                  if (!generationLease) {
                    throw new Error("Session event lost its original generation owner");
                  }
                  const assertCreationCurrent = generationLease.bindCreation(creation);
                  const assertNoticeCreationCurrent =
                    options.scheduledAutomation?.bindSessionCreation?.(creation);
                  return () => {
                    assertOwnerCurrent();
                    assertCreationCurrent();
                    assertNoticeCreationCurrent?.();
                  };
                },
              }
            : {}),
          onFailed: (error) => {
            failure ??= error instanceof Error ? error : String(error);
          },
          onSuppressed: (reason) => {
            deliverySuppressionReason = reason === "silent" ? "silent" : undefined;
            if (reason === "aborted") {
              failure ??= "Session event execution was aborted";
            }
          },
          beforeStart: () => prepareStart(),
          ...(options.scheduledAutomation ? { beforeScheduledStart: prepareStart } : {}),
          onStarted: start,
          onTerminalEvent: (event) => {
            const observation = event.data.errorObservation;
            errorReason =
              event.data.phase === "error" && isRecord(observation)
                ? FAILOVER_REASONS.find((reason) => reason === observation.failoverReason)
                : undefined;
          },
          onTerminal: async (runId, outcome, deliveryEvidence) => {
            // Settlement rechecks authority and can reject after Stop. Capture the
            // runtime's timeout/cancellation facts before that asynchronous boundary.
            terminalOutcome = mergeAgentRunTerminalOutcome(
              terminalOutcome,
              buildAgentRunTerminalOutcomeFromLifecycleEvent({
                phase: outcome === "completed" ? "end" : "error",
                data: deliveryEvidence?.meta,
                abortSignal: operation?.abortSignal ?? signal,
              }),
            );
            const terminal = await settleSessionEventTurn({
              automation: options.scheduledAutomation,
              config: { ...cfg, session: { ...cfg.session, store: storePath } },
              agentId,
              sessionKey,
              binding: preparedBinding ?? target,
              runStartedAt: input.claim.occurrence.ts,
              signal,
              assertCurrent: assertEffectCurrent,
              onFailure: (error, generic) => {
                if (generic) {
                  genericFailure ??= error;
                } else {
                  failure ??= error;
                }
              },
              runId,
              deliveryEvidence,
              prepareCurrent,
              outcome,
            });
            delivery.summary = terminal.summary ?? delivery.summary;
            nextCheckMs = terminal.nextCheckMs;
            sourceDeliveryOutcome = terminal.sourceDeliveryOutcome;
            automationResult = terminal.automationResult;
            conversationResultCommitted = terminal.conversationResultCommitted;
            delivery.delivered ||= sourceDeliveryOutcome?.satisfiesSourceDelivery === true;
          },
        },
        onQueuedFollowupReplyBatch: async (batch) => {
          if (batch.completion.kind === "failed") {
            failure ??= batch.completion.error;
          } else if (batch.completion.kind === "aborted") {
            failure ??= "Session event execution was aborted";
          }
          try {
            for (const payload of batch.payloads) {
              await deliver(payload, batch.completion.kind === "progress" ? "block" : "final");
            }
          } catch (error) {
            failure ??= error instanceof Error ? error : String(error);
            throw error;
          }
        },
        turnAdoptionLifecycle: {
          admission: "exclusive",
          abortSignal: signal,
          onDeferred: () => {
            assertCurrent();
            deferred = true;
            options.scheduledAutomation?.onLaneWait?.({ waiting: true });
            return true;
          },
          onAdopted: async () => {
            adopted = true;
            options.scheduledAutomation?.onLaneWait?.({ waiting: false });
            if (!operation) {
              throw new Error("Session event has no admitted reply owner");
            }
            // The normal owner may create a previously absent session or
            // rotate through compaction during admission. Adopt only its
            // published binding while that exact reply operation is live.
            if (
              preparedBinding &&
              !generationLease?.isCreationAdopted() &&
              preparedBinding.sessionId === operation.sessionId &&
              (target?.sessionId !== preparedBinding.sessionId ||
                target?.lifecycleRevision !== preparedBinding.lifecycleRevision)
            ) {
              generationLease?.release();
              generationLease = undefined;
              generationLease = await prepareChatLease(chatRef({ agentId, storePath, sessionKey }));
            }
            await prepareCurrent();
            await options.onAdopted?.();
            assertCurrent();
            accept();
          },
          onAbandoned: () => {
            // A stale-policy rejection before adoption also ends as abandonment;
            // only abandonment without that rejection (Stop, cleanup) is terminal.
            abandoned ||= !input.configPolicy.changed;
            genericFailure ??= "Session event was abandoned before execution";
          },
          onSettled: () => {
            if (deferred) {
              finish();
            }
          },
        },
      },
    });
    if (result.deferredToActiveRun) {
      // onDeferred precedes queue insertion; only the dispatch result proves acceptance.
      accept();
    } else {
      if (!started && waitingProvider === undefined) {
        genericFailure ??= "Session event was not admitted; retry against the current session";
      }
      finish();
    }
    await settled;
  };
  const settleExecutionFailure = (error: unknown) => {
    // Preserve the execution failure if terminal cleanup also rejects admission.
    failure ??= error instanceof Error ? error : String(error);
    if (isOperatorAuthorityUnavailable(error)) {
      errorReason = "server_error";
    }
    finish();
    return settled.then(() => undefined);
  };
  void runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      admissionStarted = true;
      const runOutsideAdmittedTurnScopes = await loadTurnReadmission();
      return runOutsideAdmittedTurnScopes(() =>
        execute()
          .catch(settleExecutionFailure)
          .finally(() => generationLease?.release()),
      );
    }, "session:event"),
  ).catch(settleExecutionFailure);
  return {
    id: occurrenceId,
    cancel: () => {
      // Producers keep this original handle; cancellation reaches the live attempt.
      if (readmittedReceipt) {
        return readmittedReceipt.cancel();
      }
      if (options.preserveOccurrenceOnRejection && !adopted && !started) {
        if (settlement === "finished" || signal.aborted) {
          return false;
        }
        // Native preparation and a queued reply retain custody until finish releases the claim.
        input.controller.abort();
        return true;
      }
      return input.claim.ownership.cancel();
    },
    settled,
    accepted: acceptance.promise,
  };
}
