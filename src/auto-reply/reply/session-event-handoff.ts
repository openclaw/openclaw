import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  execRequestAbortSignal,
  readExecRequestOwners,
  withExecRequestOwners,
} from "../../infra/exec-request-context.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueRequiredSystemEventEntry,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.cleanup-context.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";
import { narrowSessionEventSettings } from "./session-event-policy.js";
import {
  assertSessionEventTargetCurrent,
  assertSessionEventSettingsCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
  prepareSessionEventTargetForHost,
  readSessionEventTargetEnvironment,
  readSessionEventTargetOperatorAuthority,
  resolveSessionEventKey,
} from "./session-event-target.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

export {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  combineSessionEventTargetsForHost,
} from "./session-event-target.js";
export type { SessionEventReceipt, SessionEventTarget } from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

/** Policy publications an accepted occurrence may outlive before it settles as failed. */
const MAX_CONFIG_READMISSION_ATTEMPTS = 2;

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
  { assertAcceptanceCurrent, ...options }: SessionEventOptions,
): SessionEventReceipt {
  let acceptanceAssertion = assertAcceptanceCurrent;
  acceptanceAssertion?.();
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
  const operatorAuthority = options.expectedTarget
    ? readSessionEventTargetOperatorAuthority(options.expectedTarget)
    : undefined;
  operatorAuthority?.assertCurrent();
  const cfg = getSessionEventRuntimeConfig();
  const configPublication = getRuntimeConfigSnapshotMetadata();
  const agentId = normalizeAgentId(options.agentId);
  resolveConfiguredAgentId(cfg, agentId);
  const sessionKey = resolveSessionEventKey(agentId, options.sessionKey);
  if (!text.trim()) {
    throw new Error("Session event text must not be empty");
  }
  const env = options.expectedTarget
    ? readSessionEventTargetEnvironment(options.expectedTarget)
    : undefined;
  // Keep the captured destination across config remapping; live policy still gates effects.
  const storePath =
    options.expectedTarget?.storePath ??
    resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  const cleanupContext = isCronRunSessionKey(sessionKey)
    ? captureOpenClawStateWorkerContext({ env })
    : undefined;
  let target = options.expectedTarget;
  let generationLease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
  let preparedBinding: { sessionId: string; lifecycleRevision?: string } | undefined;
  if (
    options.expectedTarget &&
    ((options.expectedTarget.agentId && options.expectedTarget.agentId !== agentId) ||
      (options.expectedTarget.sessionKey && options.expectedTarget.sessionKey !== sessionKey))
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
  let route = structuredClone(options.deliveryContext ?? options.expectedTarget?.deliveryContext);
  const controller = new AbortController();
  const execRequestOwners = options.occurrences
    ? [
        ...new Set(
          options.occurrences.flatMap(
            (occurrence) =>
              readExecRequestOwners(occurrence) ?? readExecRequestOwners(options) ?? [],
          ),
        ),
      ]
    : readExecRequestOwners(options);
  const requestSignal = execRequestAbortSignal(execRequestOwners, options.abortSignal);
  const signal = AbortSignal.any(
    [requestSignal, controller.signal, operatorAuthority?.signal].filter(
      (value): value is AbortSignal => Boolean(value),
    ),
  );
  signal.throwIfAborted();
  if (options.preserveOccurrenceOnRejection && !options.occurrences?.length) {
    throw new Error("Preserving a rejected event requires its original queued occurrence");
  }
  if (
    options.occurrences &&
    options.occurrences.map((event) => event.text).join("\n") !== text.trim()
  ) {
    throw new Error("Session event occurrence text changed before admission");
  }
  const freshOccurrence = options.occurrences
    ? undefined
    : enqueueRequiredSystemEventEntry(
        text,
        withExecRequestOwners(
          withSystemEventOwner(
            {
              sessionKey,
              contextKey: options.contextKey,
              deliveryContext: route,
            },
            agentId,
          ),
          execRequestOwners,
        ),
        { allowDuplicate: true },
      );
  const occurrences = options.occurrences
    ? [...options.occurrences]
    : freshOccurrence
      ? [freshOccurrence]
      : [];
  const occurrence = occurrences[0];
  if (!occurrence?.id || occurrences.some((event) => !event.id)) {
    throw new Error("Session event was not enqueued: an identical occurrence is already pending");
  }
  const eventText = occurrences.map((event) => event.text).join("\n");
  const occurrenceId = occurrence.id;
  const ownership = claimSystemEventTurn(
    resolveSystemEventQueueKey(sessionKey, agentId),
    occurrences,
    () => controller.abort(),
    agentId,
  );
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
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
  let deliveryAttempted = false;
  let deliveryAmbiguous = false;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let summary: string | undefined;
  let failure: Error | string | undefined;
  let settlement: "settling" | "finished" | undefined;
  let settings = options.expectedTarget?.settings;
  let settingsAdmitted = false;
  const toolsAllow = options.expectedTarget?.toolsAllow;
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
    if (isAgentDeletionBlocked(agentId, { env })) {
      throw new Error("Session event agent is being deleted");
    }
    if (
      operation &&
      (operation.abortSignal.aborted || !isCurrentSessionControllerOperation(operation))
    ) {
      throw new Error("Session event admission no longer owns its destination");
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    generationLease?.assertCurrent();
    if (settingsAdmitted && generationLease) {
      assertSessionEventSettingsCurrent(settings, generationLease.readSessionSettings());
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
    for (let read = generationLease?.prepareRead(); read; read = generationLease?.prepareRead()) {
      await read;
    }
    assertCurrent();
  };
  const finish = () => {
    if (settlement) {
      return;
    }
    settlement = "settling";
    const complete = async () => {
      try {
        inputRecorder?.finishPendingInput?.(signal.aborted ? "cancelled" : "interrupted");
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
      const attempt = options.readmissionAttempt ?? 0;
      const canReadmit = configChangeRetention && attempt < MAX_CONFIG_READMISSION_ATTEMPTS;
      const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
      if (status === "failed" && !canReadmit) {
        log.error("session event execution failed", {
          source: options.source,
          agentId,
          sessionKey,
          eventId: occurrence.id,
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
          // A fresh dispatch binds the current policy for admission, execution and
          // delivery. The captured target, producer assertions, cancellation and
          // delivery opt-out carry over, so a moved destination or retired producer
          // still rejects. Only an occurrence that was already a passive notice keeps
          // passive custody on rejection; producer-owned text never becomes passive.
          readmittedReceipt = enqueueSessionEventForHost(eventText, {
            agentId,
            sessionKey,
            source: options.source,
            contextKey: options.contextKey,
            sourceTurnId: options.sourceTurnId,
            deliveryContext: options.deliveryContext,
            abortSignal: options.abortSignal,
            expectedTarget: options.expectedTarget,
            createIfMissing: options.createIfMissing,
            assertAcceptanceCurrent: pendingAcceptanceAssertion,
            onAdopted: options.onAdopted,
            occurrences,
            preserveOccurrenceOnRejection: preservePassive,
            readmissionAttempt: attempt + 1,
            deliver: options.deliver,
            assertCurrent: options.assertCurrent,
          });
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
            eventId: occurrence.id,
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
        delivered,
        deliveryAttempted,
        deliveryAmbiguous,
        deliverySuppressionReason,
        admissionDeferred:
          !started &&
          operation?.result?.kind === "aborted" &&
          operation.result.code === "aborted_for_supersession",
        summary,
        ...(failure ? { error: String(failure) } : {}),
        ...(failure instanceof SessionWorkStartError ? { retryable: failure.retryable } : {}),
      });
      if (cleanupContext) {
        // Cleanup must outlive the completed event's async work scope.
        void runWithGatewayDetachedWorkContinuation(
          () =>
            runWithSessionControllerCleanup(async () => {
              const { removeCronRunContinuationSessionIfIdle } =
                await import("../../cron/run-continuation-cleanup.js");
              await removeCronRunContinuationSessionIfIdle(
                sessionKey,
                undefined,
                cleanupContext,
                storePath,
              );
            }),
          "session:event-cleanup",
        ).catch((error: unknown) => {
          log.warn("Could not remove settled cron continuation", { error: String(error) });
        });
      }
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
    if (options.deliver === false || target?.deliver === false) {
      return;
    }
    if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
      // The normal transcript remains the result for internal/WebChat turns.
      // This is not evidence of a transport send.
      return;
    }
    const { isRoutableChannel, routeReply } = await import("./route-reply.js");
    assertCurrent();
    if (!isRoutableChannel(route?.channel) || !route?.to) {
      throw new Error(
        "Session event has no original external delivery route; inspect the session result or choose a delivery destination",
      );
    }
    deliveryAttempted = true;
    const deliveryConfig = getSessionEventRuntimeConfig();
    const result = await routeReply({
      cfg: deliveryConfig,
      agentId,
      sessionKey,
      channel: route.channel,
      to: route.to,
      accountId: route.accountId,
      threadId: route.threadId,
      payload,
      replyKind: kind,
      abortSignal: signal,
      mirror: false,
      beforeDeliver: async () => assertEffectCurrent(),
      assertCurrent: assertEffectCurrent,
    });
    delivered ||= result.delivered;
    deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      throw new Error(result.error ?? "Session event delivery failed");
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
      settings = narrowSessionEventSettings(settings, generationLease.readSessionSettings());
      settingsAdmitted = true;
      assertCurrent();
      const ctx: MsgContext = {
        AgentId: agentId,
        SessionKey: sessionKey,
        Body: eventText,
        BodyForAgent: eventText,
        InternalTurnSource: "event",
        BodyForCommands: "",
        CommandBody: "",
        RawBody: "",
        CommandAuthorized: false,
        InputProvenance: { kind: "internal_system", sourceTool: options.source },
        ChatType: channelRouteTargetsMatchExact({ left: route, right: target.deliveryContext })
          ? target.chatType
          : undefined,
        Surface: route?.channel ?? INTERNAL_MESSAGE_CHANNEL,
        Provider: route?.channel ?? INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: route?.channel,
        OriginatingTo: route?.to,
        AccountId: route?.accountId,
        MessageThreadId: route?.threadId,
        // Inbound dedupe retains an adopted attempt's id; a policy re-admission is a new dispatch.
        MessageSid: options.readmissionAttempt
          ? `${occurrence.id}:readmission-${options.readmissionAttempt}`
          : occurrence.id,
      };
      setChannelSourceTurnId(ctx, options.sourceTurnId);
      const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: { ...cfg, session: { ...cfg.session, store: storePath } },
        ctx,
        dispatcherOptions: {
          deliver: (payload, info) => deliver(payload, info.kind),
          onError: (error) => {
            failure = error instanceof Error ? error : String(error);
          },
          onSkip: (_payload, info) => {
            if (info.kind === "final") {
              deliverySuppressionReason = info.reason;
            }
          },
        },
        replyOptions: {
          operatorAuthority,
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
                !(await recorder.stageApproved({ runId: occurrenceId, assertCurrent }))
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
                    return () => {
                      assertOwnerCurrent();
                      assertCreationCurrent();
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
            beforeStart: prepareCurrent,
            onStarted: () => {
              assertCurrent();
              ownership.start();
              started = true;
              accept();
            },
            onTerminal: (_runId, outcome) => {
              if (outcome !== "completed") {
                failure ??= `Session event execution ${outcome}`;
              }
              assertCurrent();
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
              failure = error instanceof Error ? error : String(error);
              throw error;
            }
          },
          turnAdoptionLifecycle: {
            admission: "exclusive",
            abortSignal: signal,
            onDeferred: () => {
              assertCurrent();
              deferred = true;
              return true;
            },
            onAdopted: async () => {
              adopted = true;
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
      // Admission can reject before invoking the callback (for example on restart).
      failure = error instanceof Error ? error : String(error);
      finish();
      return settled.then(() => undefined);
    })
    .finally(() => generationLease?.release());
  return {
    id: occurrence.id,
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
