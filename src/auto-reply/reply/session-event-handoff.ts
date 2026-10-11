import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  execRequestAbortSignal,
  readExecRequestOwners,
  withExecRequestOwners,
} from "../../infra/exec-request-context.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueRequiredSystemEventEntry,
  type SystemEvent,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import { settleSessionAutomationTurn } from "./session-event-automation.js";
import type {
  ScheduledSessionAutomation,
  SessionEventOutcome,
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";
import { narrowSessionEventSettings } from "./session-event-policy.js";
import {
  assertSessionEventTargetCurrent,
  assertSessionEventSettingsCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
  intersectSessionEventToolsAllow,
  prepareSessionEventTargetForHost,
  readSessionEventTargetEnvironment,
  resolveSessionEventKey,
} from "./session-event-target.js";
export {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  combineSessionEventTargetsForHost,
} from "./session-event-target.js";
export type {
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
  {
    assertAcceptanceCurrent,
    ...options
  }: {
    agentId: string;
    sessionKey: string;
    source: SessionEventSource;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
    /** Authorized fresh work may create an absent session; captured completions may not. */
    createIfMissing?: true;
    /** Submitting invocation custody lasts through acceptance only. */
    assertAcceptanceCurrent?: () => void;
    /** Durable producer commits its attempt only after normal turn adoption. */
    onAdopted?: () => void | Promise<void>;
    /** Transfer exact queued occurrences into one ordinary turn without duplicating them. */
    occurrences?: readonly SystemEvent[];
    scheduledAutomation?: ScheduledSessionAutomation;
    /** Failed promotion retains an existing passive occurrence until ordinary adoption begins. */
    preserveOccurrenceOnRejection?: true;
    /** An explicitly silent source records its result without transport delivery. */
    deliver?: boolean;
    /** Host producer remains live through admission, execution and delivery. */
    assertCurrent?: () => void;
  },
): SessionEventReceipt {
  let acceptanceAssertion = assertAcceptanceCurrent;
  acceptanceAssertion?.();
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
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
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  let target = options.expectedTarget;
  let generationLease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
  let preparedBinding: { sessionId: string; lifecycleRevision?: string } | undefined;
  const generation = options.expectedTarget?.generation ?? getAgentEventLifecycleGeneration();
  if (
    options.expectedTarget &&
    ((options.expectedTarget.storePath && options.expectedTarget.storePath !== storePath) ||
      (options.expectedTarget.agentId && options.expectedTarget.agentId !== agentId) ||
      (options.expectedTarget.sessionKey && options.expectedTarget.sessionKey !== sessionKey))
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
  assertAgentRunLifecycleGenerationCurrent(generation);
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
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
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
  const ownership = claimSystemEventTurn(
    resolveSystemEventQueueKey(sessionKey, agentId),
    occurrences,
    () => controller.abort(),
    agentId,
  );
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  const acceptance = createDeferredCore<Awaited<SessionEventReceipt["accepted"]>>();
  let accepted = false;
  let started = false;
  let admissionStarted = false;
  let deferred = false;
  let admissionDeferred = false;
  let admissionDeferredReason: SessionEventOutcome["admissionDeferredReason"];
  const shouldDeferScheduledStart = () => {
    const decision = options.scheduledAutomation?.beforeStart?.(operation);
    if (decision === undefined || decision === true) {
      return false;
    }
    admissionDeferredReason = typeof decision === "string" ? decision : undefined;
    return true;
  };
  let adopted = false;
  let operation: ReplyOperation | undefined;
  let replyRunRegistry: (typeof import("./reply-run-registry.js"))["replyRunRegistry"];
  let delivered = false;
  let deliveryAttempted = false;
  let deliveryAmbiguous = false;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let summary: string | undefined;
  let failure: string | undefined;
  let nextCheckMs: number | undefined;
  let sourceDeliveryOutcome: SourceDeliveryOutcome | undefined;
  let settlement: "settling" | "finished" | undefined;
  let settings = options.expectedTarget?.settings;
  let settingsAdmitted = false;
  const jobTools = options.scheduledAutomation?.job.payload.toolsAllow;
  const producerTools = options.expectedTarget?.toolsAllow;
  const toolsAllow = intersectSessionEventToolsAllow(jobTools, producerTools);
  const assertOwnerCurrent = () => {
    if (settlement === "finished") {
      throw new Error("Session event occurrence is settled");
    }
    signal.throwIfAborted();
    if (!accepted) {
      acceptanceAssertion?.();
    }
    options.assertCurrent?.();
    options.expectedTarget?.assertCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(generation);
    const currentConfig = getSessionEventRuntimeConfig();
    if (currentConfig !== cfg || getRuntimeConfigSnapshotMetadata() !== configPublication) {
      throw new Error("Session event configuration changed; retry under the current policy");
    }
    resolveConfiguredAgentId(currentConfig, agentId);
    if (resolveSessionStorePathCore(currentConfig.session?.store, { agentId, env }) !== storePath) {
      throw new Error("Session event destination store changed before settlement");
    }
    if (isAgentDeletionBlocked(agentId, { env })) {
      throw new Error("Session event agent is being deleted");
    }
    options.scheduledAutomation?.assertCurrent();
    if (
      operation &&
      (operation.abortSignal.aborted || replyRunRegistry.get(sessionKey) !== operation)
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
  const start = (runId: string) => {
    assertCurrent();
    if (started) {
      return;
    }
    options.scheduledAutomation?.onStarted?.();
    ownership.start();
    started = true;
    accept();
    options.scheduledAutomation?.onExecutionStarted?.({
      runId,
      sessionId: operation?.sessionId,
      sessionKey,
    });
  };
  const prepareStart = async (runId?: string) => {
    if (started) {
      await prepareCurrent();
      return;
    }
    const startSignal = operation ? AbortSignal.any([signal, operation.abortSignal]) : signal;
    await prepareCurrent();
    if (started) {
      return;
    }
    while (shouldDeferScheduledStart()) {
      if (admissionDeferredReason === "busy" && options.scheduledAutomation?.waitForIdle) {
        await options.scheduledAutomation.waitForIdle(startSignal, operation);
        assertCurrent();
        await prepareCurrent();
        continue;
      }
      admissionDeferred = true;
      throw new Error("Automation admission deferred by its current window or foreground activity");
    }
    if (runId) {
      // Commit the policy decision before native binding; later visible progress cannot veto it.
      start(runId);
    }
  };
  const finish = () => {
    if (settlement) {
      return;
    }
    settlement = "settling";
    const complete = () => {
      settlement = "finished";
      acceptanceAssertion = undefined;
      const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
      if (status === "failed") {
        log.error("session event execution failed", {
          source: options.source,
          agentId,
          sessionKey,
          eventId: occurrence.id,
          error: failure,
        });
      }
      if (!accepted) {
        acceptance.resolve({
          ok: false,
          error: failure ?? "Session event was cancelled before acceptance",
        });
      }
      signal.removeEventListener("abort", onAbort);
      generationLease?.release();
      if (options.preserveOccurrenceOnRejection && !adopted && !started) {
        ownership.release();
      } else {
        ownership.cancel();
      }
      resolve({
        status,
        executionStarted: started,
        delivered,
        deliveryAttempted,
        deliveryAmbiguous,
        deliverySuppressionReason,
        admissionDeferredReason: !started ? admissionDeferredReason : undefined,
        admissionDeferred:
          !started &&
          (admissionDeferred ||
            (operation?.result?.kind === "aborted" &&
              operation.result.code === "aborted_for_supersession")),
        summary,
        nextCheckMs,
        sourceDeliveryOutcome,
        ...(failure ? { error: failure } : {}),
      });
    };
    if (operation?.ownerSettlement) {
      void operation.ownerSettlement.then(complete, complete);
    } else {
      complete();
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
    if (kind === "final" && sourceDeliveryOutcome?.satisfiesSourceDelivery) {
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
    const assertDeliveryCurrent = () => {
      assertCurrent();
      options.scheduledAutomation?.assertDeliveryCurrent?.();
      if (getSessionEventRuntimeConfig() !== deliveryConfig) {
        throw new Error("Session event delivery policy changed before send");
      }
    };
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
      beforeDeliver: async () => {
        await options.scheduledAutomation?.beforeDeliver?.();
        assertDeliveryCurrent();
      },
      assertCurrent: assertDeliveryCurrent,
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
      assertOwnerCurrent();
      ({ replyRunRegistry } = await import("./reply-run-registry.js"));
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
      const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: { ...cfg, session: { ...cfg.session, store: storePath } },
        ctx: {
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
          MessageSid: occurrence.id,
        },
        dispatcherOptions: {
          deliver: (payload, info) => deliver(payload, info.kind),
          onError: (error) => {
            failure = String(error);
          },
          onSkip: (_payload, info) => {
            if (info.kind === "final") {
              deliverySuppressionReason = info.reason;
            }
          },
        },
        replyOptions: {
          scheduledAutomation: options.scheduledAutomation,
          ...(options.scheduledAutomation
            ? {
                sourceReplyDeliveryMode: "automatic" as const,
                allowEmptyAssistantReplyAsSilent: true,
              }
            : {}),
          admittedSessionSettings: settings,
          toolsAllow,
          onDeliberateSilentTerminalReply: () => {
            deliverySuppressionReason = "silent";
          },
          ...(options.scheduledAutomation?.job.payload.kind === "agentTurn"
            ? {
                modelOverride: options.scheduledAutomation.job.payload.model,
                thinkingLevelOverride: options.scheduledAutomation.job.payload.thinking,
                timeoutOverrideSeconds: options.scheduledAutomation.job.payload.timeoutSeconds,
                bootstrapContextMode: options.scheduledAutomation.job.payload.lightContext
                  ? "lightweight"
                  : "full",
              }
            : {}),
          abortSignal: signal,
          expectedExistingSessionId: target.sessionId || undefined,
          pinExpectedExistingSession: Boolean(target.sessionId),
          onSessionPrepared: (binding) => {
            if (binding.sessionKey === sessionKey) {
              preparedBinding = binding;
            }
          },
          onReplyOperationOwned: (owned) => {
            operation = owned;
          },
          queueModeOverride: "followup",
          suppressTyping: true,
          typingPolicy: "system_event",
          internalEventExecution: {
            execRequestOwners,
            deliver: options.deliver === false || target.deliver === false ? false : undefined,
            assertCurrent,
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
              failure ??= String(error);
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
              if (outcome !== "completed") {
                failure ??= `Session event execution ${outcome}`;
              }
              assertCurrent();
              if (options.scheduledAutomation) {
                const automationOutcome = await settleSessionAutomationTurn({
                  automation: options.scheduledAutomation,
                  runId,
                  deliveryEvidence,
                  cfg,
                  scope: preparedBinding
                    ? { agentId, sessionKey, storePath, ...preparedBinding }
                    : undefined,
                  assertCurrent,
                  prepareCurrent,
                });
                summary = automationOutcome.summary ?? summary;
                nextCheckMs = automationOutcome.nextCheckMs;
                sourceDeliveryOutcome = automationOutcome.sourceDeliveryOutcome;
                delivered ||= sourceDeliveryOutcome?.satisfiesSourceDelivery === true;
              }
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
              failure = String(error);
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
              operation = replyRunRegistry.get(sessionKey);
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
      failure = String(error);
      finish();
      return settled.then(() => undefined);
    })
    .finally(() => generationLease?.release());
  return {
    id: occurrence.id,
    cancel: () => {
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
