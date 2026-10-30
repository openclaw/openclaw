import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import { execRequestAbortSignal } from "../../infra/exec-request-context.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { claimSystemEventTurn } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import {
  prepareCronRunContinuationCleanup,
  prepareScheduledAutomationStart,
  resolveScheduledSessionReplyOptions,
  settleSessionEventTurn,
  type ScheduledAutomationAdmission,
} from "./session-event-automation.js";
import {
  claimSessionEventOccurrenceInput,
  buildSessionEventContext,
  prepareSessionEventInput,
  resolveSessionEventExecRequestOwners,
} from "./session-event-context.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";
import { prepareSessionEventDelivery } from "./session-event-delivery.js";
import { narrowSessionEventSettings } from "./session-event-policy.js";
import {
  assertSessionEventTargetCurrent,
  assertSessionEventSettingsCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
  hasSessionEventOriginatingCaller,
  intersectSessionEventToolsAllow,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";

export { assertSessionEventTargetCurrent, captureSessionEventTargetForHost };
export { combineSessionEventTargetsForHost } from "./session-event-target.js";
export type { SessionEventReceipt, SessionEventTarget } from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

/** Policy publications an accepted occurrence may outlive before it settles as failed. */
const MAX_CONFIG_READMISSION_ATTEMPTS = 2;

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
  options: SessionEventOptions,
): SessionEventReceipt {
  return enqueueSessionEventAttempt(text, options, 0);
}

function enqueueSessionEventAttempt(
  text: string,
  { assertAcceptanceCurrent, ...options }: SessionEventOptions,
  readmissionAttempt: number,
): SessionEventReceipt {
  let acceptanceAssertion = assertAcceptanceCurrent;
  acceptanceAssertion?.();
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
  const { cfg, configPublication, agentId, sessionKey, env, storePath, operatorAuthority } =
    prepareSessionEventInput(text, options);
  const cleanupContinuation = prepareCronRunContinuationCleanup(sessionKey, storePath, env);
  let target = options.expectedTarget;
  let generationLease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
  let preparedBinding: { sessionId: string; lifecycleRevision?: string } | undefined;
  let route = structuredClone(options.deliveryContext ?? options.expectedTarget?.deliveryContext);
  const controller = new AbortController();
  const execRequestOwners = resolveSessionEventExecRequestOwners(options);
  const requestSignal = execRequestAbortSignal(execRequestOwners, options.abortSignal);
  const signal = AbortSignal.any(
    [requestSignal, controller.signal, operatorAuthority?.signal].filter(
      (value): value is AbortSignal => Boolean(value),
    ),
  );
  signal.throwIfAborted();
  const { occurrence, occurrences, occurrenceId, eventText, ownership } =
    claimSessionEventOccurrenceInput({
      text,
      options,
      sessionKey,
      agentId,
      route,
      execRequestOwners,
      cancel: () => controller.abort(),
    });
  let releaseOperatorAuthority: (() => void) | undefined;
  try {
    // Transfer custody before the completed process releases its original source.
    releaseOperatorAuthority = operatorAuthority?.retain?.();
  } catch (error) {
    ownership.cancel();
    throw error;
  }
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  const acceptance = createDeferredCore<Awaited<SessionEventReceipt["accepted"]>>();
  let accepted = false;
  let started = false;
  let admissionStarted = false;
  let deferred = false;
  const automationAdmission: ScheduledAutomationAdmission = { admissionDeferred: false };
  let adopted = false;
  // A policy publication rejected this occurrence's stale-config execution; finish()
  // re-admits it under the current policy when it never started.
  let configPublicationChanged = false;
  // Queue-owner abandonment (lifecycle cleanup) stays terminal.
  let abandoned = false;
  // The live re-admission attempt; receipt.cancel forwards to it once it exists.
  let readmittedReceipt: SessionEventReceipt | undefined;
  let operation: ReplyOperation | undefined;
  let inputRecorder: UserTurnTranscriptRecorder | undefined;
  let delivered = false;
  let conversationResultCommitted: true | undefined;
  let deliveryAttempted = false;
  let deliveryAmbiguous = false;
  let deliveryError: string | undefined;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let summary: string | undefined;
  let failure: Error | string | undefined;
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
    operatorAuthority?.assertCurrent();
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
  const assertEffectCurrent = () => {
    assertCurrent();
    if (
      getSessionEventRuntimeConfig() !== cfg ||
      getRuntimeConfigSnapshotMetadata() !== configPublication
    ) {
      // The dispatched run holds the config captured at enqueue; it must never execute
      // under a superseded policy. finish() re-admits an unstarted occurrence instead.
      configPublicationChanged = true;
      throw new Error("Session event configuration changed; retry under the current policy");
    }
  };
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
    ownership.start();
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
      onReady: runId ? start : undefined,
    });
  };
  const finish = () => {
    if (settlement) {
      return;
    }
    settlement = "settling";
    const complete = async () => {
      try {
        inputRecorder?.finishPendingInput?.("cancelled");
        await inputRecorder?.waitForPendingInputSettlement?.();
      } catch (error) {
        failure ??= error instanceof Error ? error : String(error);
      }
      settlement = "finished";
      // Submitting custody ends at the first acceptance; a pre-acceptance re-admission
      // carries the still-live assertion so revoked ingress rejects the retry.
      const pendingAcceptanceAssertion = accepted ? undefined : acceptanceAssertion;
      acceptanceAssertion = undefined;
      // Producers never retry, so a policy publication that rejected an unstarted
      // occurrence re-admits it under the current policy instead of destroying it.
      // Stop, abort and abandonment still settle terminally.
      const configChangeRetention =
        configPublicationChanged && !started && !deliveryAttempted && !signal.aborted && !abandoned;
      const attempt = readmissionAttempt;
      const canReadmit = configChangeRetention && attempt < MAX_CONFIG_READMISSION_ATTEMPTS;
      const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
      if (status === "failed" && !canReadmit) {
        log.error("session event execution failed", {
          source: options.source,
          agentId,
          sessionKey,
          eventId: occurrenceId,
          error: String(failure),
        });
      }
      signal.removeEventListener("abort", onAbort);
      generationLease?.release();
      if (canReadmit) {
        // Passive custody survives only until some attempt adopts the occurrence.
        const preservePassive =
          options.preserveOccurrenceOnRejection && !adopted ? true : undefined;
        ownership.release();
        try {
          // Re-admit under current policy with original target, producer checks, cancellation
          // and delivery opt-out; only previously passive notices keep custody on rejection.
          readmittedReceipt = enqueueSessionEventAttempt(
            eventText,
            {
              ...options,
              agentId,
              sessionKey,
              assertAcceptanceCurrent: pendingAcceptanceAssertion,
              occurrences,
              preserveOccurrenceOnRejection: preservePassive,
            },
            attempt + 1,
          );
        } catch (error) {
          if (!preservePassive) {
            // The released occurrence carries no producer contract; consume it.
            claimSystemEventTurn(
              resolveSystemEventQueueKey(sessionKey, agentId),
              occurrences,
              () => {},
              agentId,
            )?.cancel();
          }
          failure = error instanceof Error ? error : String(error);
          log.error("session event policy readmission rejected", {
            source: options.source,
            agentId,
            sessionKey,
            eventId: occurrenceId,
            error: String(failure),
          });
        }
      } else if (options.preserveOccurrenceOnRejection && !adopted && !started) {
        ownership.release();
      } else {
        ownership.cancel();
      }
      releaseOperatorAuthority?.();
      releaseOperatorAuthority = undefined;
      if (!accepted) {
        acceptance.resolve(
          readmittedReceipt?.accepted ?? {
            ok: false,
            error: failure ? String(failure) : "Session event was cancelled before acceptance",
          },
        );
      }
      if (readmittedReceipt) {
        resolve(readmittedReceipt.settled);
        return;
      }
      resolve({
        status,
        executionStarted: started,
        interruptedByRestart:
          status !== "completed" &&
          resolveAgentRunErrorLifecycleFields(failure, operation?.abortSignal ?? signal)
            .stopReason === "restart",
        delivered,
        conversationResultCommitted,
        deliveryAttempted,
        deliveryAmbiguous,
        deliveryError,
        deliverySuppressionReason,
        admissionDeferredReason: !started ? automationAdmission.admissionDeferredReason : undefined,
        admissionDeferred:
          !started &&
          (automationAdmission.admissionDeferred ||
            (operation?.result?.kind === "aborted" &&
              operation.result.code === "aborted_for_supersession")),
        summary,
        nextCheckMs,
        sourceDeliveryOutcome,
        automationResult,
        ...(failure ? { error: String(failure) } : {}),
        ...(failure instanceof SessionWorkStartError ? { retryable: failure.retryable } : {}),
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
  const deliver = async (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    await prepareCurrent();
    if (kind === "final" && payload.text) {
      summary ??= truncateUtf16Safe(payload.text, 2000);
    }
    if (
      options.deliver === false ||
      target?.deliver === false ||
      (options.suppressErrorDelivery && payload.isError === true)
    ) {
      return;
    }
    if (kind === "final" && sourceDeliveryOutcome?.satisfiesSourceDelivery) {
      return;
    }
    if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
      // The normal transcript remains the result for internal/WebChat turns.
      // This is not evidence of a transport send.
      return;
    }
    const deliverReply = await prepareSessionEventDelivery(route, assertCurrent);
    deliveryAttempted = true;
    const assertDeliveryCurrent = () => {
      assertEffectCurrent();
      options.scheduledAutomation?.assertDeliveryCurrent?.();
    };
    const result = await deliverReply({
      cfg: getSessionEventRuntimeConfig(),
      agentId,
      sessionKey,
      payload,
      replyKind: kind,
      abortSignal: signal,
      beforeDeliver: async () => {
        await options.scheduledAutomation?.beforeDeliver?.();
        assertDeliveryCurrent();
      },
      assertCurrent: assertDeliveryCurrent,
    });
    delivered ||= result.delivered;
    deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      if (!options.scheduledAutomation) {
        throw new Error(result.error ?? "Session event delivery failed");
      }
      // Cron records transport failure separately from completed agent work.
      deliveryError = result.error ?? "Session event delivery failed";
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Completion outlives the producer's request scope and transcript writer.
  // Keep detached work through settlement; explicit request/Stop signals above
  // still cancel the occurrence and join its native execution owner.
  void runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      admissionStarted = true;
      await readAgentDeletionJournalStatusInWorker(agentId, { env }, signal);
      isDeletionBlocked = prepareAgentDeletionBlocked(agentId, { env });
      assertOwnerCurrent();
      const { dispatchInboundMessageWithRoutedChannelDispatcher } = await import("../dispatch.js");
      const { prepareSessionGenerationFacts } =
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
      settings ??= target.settings;
      route ??= structuredClone(target.deliveryContext);
      await prepareCurrent();
      checkedSettings = generationLease.readSessionSettings();
      settings = narrowSessionEventSettings(settings, checkedSettings);
      const promptText = options.scheduledAutomation?.preparePrompt
        ? await options.scheduledAutomation.preparePrompt(cfg)
        : eventText;
      assertEffectCurrent();
      const ctx = buildSessionEventContext({
        cfg,
        agentId,
        sessionKey,
        text: promptText,
        options,
        readmissionAttempt,
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
          sessionPrincipalTurn:
            !options.scheduledAutomation &&
            !isCronSessionKey(sessionKey) &&
            !hasSessionEventOriginatingCaller(target),
          scheduledAutomation: options.scheduledAutomation,
          ...resolveScheduledSessionReplyOptions(options.scheduledAutomation),
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
            prepareInput: async (recorder) => {
              inputRecorder = recorder;
              if (
                !recorder.stageApproved ||
                !(await recorder.stageApproved({
                  runId: occurrenceId,
                  assertCurrent,
                  // Only this live policy retry can reclaim its cancelled attempt.
                  retryCancelled: readmissionAttempt > 0,
                }))
              ) {
                throw new Error("Session event input was not durably admitted");
              }
            },
            execRequestOwners,
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
            onTerminal: async (runId, outcome, deliveryEvidence) => {
              const terminal = await settleSessionEventTurn({
                automation: options.scheduledAutomation,
                config: { ...cfg, session: { ...cfg.session, store: storePath } },
                agentId,
                sessionKey,
                binding: preparedBinding ?? target,
                runStartedAt: occurrence.ts,
                signal,
                assertCurrent: assertEffectCurrent,
                onFailure: (error) => {
                  failure ??= error;
                },
                runId,
                deliveryEvidence,
                prepareCurrent,
                outcome,
              });
              summary = terminal.summary ?? summary;
              nextCheckMs = terminal.nextCheckMs;
              sourceDeliveryOutcome = terminal.sourceDeliveryOutcome;
              automationResult = terminal.automationResult;
              conversationResultCommitted = terminal.conversationResultCommitted;
              delivered ||= sourceDeliveryOutcome?.satisfiesSourceDelivery === true;
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
                generationLease = await prepareSessionGenerationFacts({
                  agentId,
                  storePath,
                  sessionKey,
                  sessionId: preparedBinding.sessionId,
                  lifecycleRevision: preparedBinding.lifecycleRevision ?? null,
                });
              }
              await prepareCurrent();
              await options.onAdopted?.();
              assertCurrent();
              accept();
            },
            onAbandoned: () => {
              // A stale-policy rejection before adoption also ends as abandonment;
              // only abandonment without that rejection (Stop, cleanup) is terminal.
              abandoned ||= !configPublicationChanged;
              failure ??= "Session event was abandoned before execution";
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
        if (!started) {
          failure ??= "Session event was not admitted; retry against the current session";
        }
        finish();
      }
      await settled;
    }, "session:event"),
  )
    .catch((error: unknown) => {
      // Preserve the execution failure if terminal cleanup also rejects admission.
      failure ??= error instanceof Error ? error : String(error);
      finish();
      return settled.then(() => undefined);
    })
    .finally(() => generationLease?.release());
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
        controller.abort();
        return true;
      }
      return ownership.cancel();
    },
    settled,
    accepted: acceptance.promise,
  };
}
