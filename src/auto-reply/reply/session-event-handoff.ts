import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueSystemEventEntry,
  type SystemEvent,
} from "../../infra/system-events.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import type {
  ScheduledSessionAutomation,
  SessionEventOutcome,
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
  prepareSessionEventTargetForHost,
  readSessionEventTargetEnvironment,
  resolveSessionEventKey,
} from "./session-event-target.js";
export {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";
export type {
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
  options: {
    agentId: string;
    sessionKey: string;
    source: SessionEventSource;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
    /** Durable producer commits its attempt only after normal turn adoption. */
    onAdopted?: () => void | Promise<void>;
    /** Transfer an existing producer-owned queue occurrence without duplicating its text. */
    occurrence?: SystemEvent;
    scheduledAutomation?: ScheduledSessionAutomation | undefined;
    /** An explicit silent job records its result without transport delivery. */
    deliver?: boolean;
    /** Host producer remains live through admission, execution and delivery. */
    assertCurrent?: () => void;
  },
): SessionEventReceipt {
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
  const cfg = getSessionEventRuntimeConfig();
  const agentId = normalizeAgentId(options.agentId);
  resolveConfiguredAgentId(cfg, agentId);
  const sessionKey = resolveSessionEventKey(agentId, options.sessionKey);
  const keyOwner = parseAgentSessionKey(sessionKey)?.agentId;
  if (!sessionKey || (keyOwner !== undefined && keyOwner !== agentId)) {
    throw new Error("Session event requires an exact session owned by its agent");
  }
  if (!text.trim()) {
    throw new Error("Session event text must not be empty");
  }
  const env = options.expectedTarget
    ? readSessionEventTargetEnvironment(options.expectedTarget)
    : undefined;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  let target = options.expectedTarget;
  let generationLease:
    | Awaited<
        ReturnType<
          typeof import("../../config/sessions/session-delivery-generation.js").prepareSessionGenerationFacts
        >
      >
    | undefined;
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
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal;
  if (options.occurrence && options.occurrence.text !== text.trim()) {
    throw new Error("Session event occurrence text changed before admission");
  }
  const occurrence =
    options.occurrence ??
    enqueueSystemEventEntry(
      text,
      withSystemEventOwner(
        {
          sessionKey,
          contextKey: options.contextKey,
          deliveryContext: route,
        },
        agentId,
      ),
      { allowDuplicate: true },
    );
  if (!occurrence?.id) {
    throw new Error("Session event was not enqueued: an identical occurrence is already pending");
  }
  const ownership = claimSystemEventTurn(
    resolveSystemEventQueueKey(sessionKey, agentId),
    occurrence,
    () => controller.abort(),
    agentId,
  );
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  let started = false;
  let dispatchStarted = false;
  let deferred = false;
  let admissionDeferred = false;
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
  let finished = false;
  let settling = false;
  let settings = options.expectedTarget?.settings;
  const jobTools = options.scheduledAutomation?.job.payload.toolsAllow;
  const producerTools = options.expectedTarget?.toolsAllow;
  const toolsAllow =
    jobTools && producerTools
      ? attachToolAllowlistIntersection([...jobTools], [[...producerTools]])
      : (jobTools ?? producerTools);
  const assertOwnerCurrent = () => {
    if (finished) {
      throw new Error("Session event occurrence is settled");
    }
    signal.throwIfAborted();
    options.assertCurrent?.();
    options.expectedTarget?.assertCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(generation);
    const currentConfig = getSessionEventRuntimeConfig();
    resolveConfiguredAgentId(currentConfig, agentId);
    if (resolveSessionStorePathCore(currentConfig.session?.store, { agentId, env }) !== storePath) {
      throw new Error("Session event destination store changed before settlement");
    }
    if (isAgentDeletionBlocked(agentId)) {
      throw new Error("Session event agent is being deleted");
    }
    options.scheduledAutomation?.assertCurrent();
    if (operation) {
      if (operation.abortSignal.aborted) {
        throw new Error("Session event admission no longer owns its destination");
      }
      if (replyRunRegistry.get(sessionKey) !== operation) {
        throw new Error("Session event admission no longer owns its destination");
      }
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    generationLease?.assertCurrent();
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
  const finish = () => {
    if (settling) {
      return;
    }
    settling = true;
    const complete = () => {
      finished = true;
      const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
      signal.removeEventListener("abort", onAbort);
      generationLease?.release();
      ownership.cancel();
      resolve({
        status,
        executionStarted: started,
        delivered,
        deliveryAttempted,
        deliveryAmbiguous,
        deliverySuppressionReason,
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
    // Adopted work settles through its operation, including cancellation before model start.
    // Otherwise callers can release a cron reservation while its reply owner is still live.
    if (!operation && !dispatchStarted) {
      finish();
    }
  };
  const deliver = async (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    await prepareCurrent();
    if (kind === "final" && payload.text) {
      summary ??= truncateUtf16Safe(payload.text, 2000);
    }
    if (options.deliver === false || options.expectedTarget?.deliver === false) {
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
        assertCurrent();
        if (getSessionEventRuntimeConfig() !== deliveryConfig) {
          throw new Error("Session event delivery policy changed before send");
        }
      },
      assertCurrent: () => {
        assertCurrent();
        if (getSessionEventRuntimeConfig() !== deliveryConfig) {
          throw new Error("Session event delivery policy changed before send");
        }
        options.scheduledAutomation?.assertDeliveryCurrent?.();
      },
    });
    delivered ||= result.delivered;
    deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      throw new Error(result.error ?? "Session event delivery failed");
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Completion outlives the producer's root and transcript writer. Keep its
  // independent root through settlement: queued dispatch returns before the
  // eventual execution and delivery finish.
  void runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayIndependentRootWorkContinuation(async () => {
      ({ replyRunRegistry } = await import("./reply-run-registry.js"));
      const { dispatchInboundMessageWithRoutedChannelDispatcher } = await import("../dispatch.js");
      const { prepareSessionGenerationFacts } =
        await import("../../config/sessions/session-delivery-generation.js");
      target ??= await captureSessionEventTargetForHost(agentId, sessionKey, {
        env,
        assertCurrent: options.assertCurrent,
      });
      assertSessionEventTargetCurrent(target);
      generationLease = await prepareSessionGenerationFacts({
        agentId,
        storePath,
        sessionKey,
        sessionId: target.sessionId || null,
        lifecycleRevision: target.lifecycleRevision ?? null,
      });
      settings ??= target.settings;
      route ??= structuredClone(target.deliveryContext);
      await prepareCurrent();
      dispatchStarted = true;
      const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: { ...cfg, session: { ...cfg.session, store: storePath } },
        ctx: {
          AgentId: agentId,
          SessionKey: sessionKey,
          Body: occurrence.text,
          BodyForAgent: occurrence.text,
          InternalTurnSource: "event",
          BodyForCommands: "",
          CommandBody: "",
          RawBody: "",
          CommandAuthorized: false,
          InputProvenance: { kind: "internal_system", sourceTool: options.source },
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
            onFailed: (error) => {
              failure ??= String(error);
            },
            onSuppressed: (reason) => {
              deliverySuppressionReason = reason === "silent" ? "silent" : undefined;
              if (reason === "aborted") {
                failure ??= "Session event execution was aborted";
              }
            },
            beforeStart: async () => {
              await options.scheduledAutomation?.capacity?.resume(signal);
              await prepareCurrent();
              if (options.scheduledAutomation?.beforeStart?.() === false) {
                admissionDeferred = true;
                throw new Error(
                  "Automation admission deferred by its current window or foreground activity",
                );
              }
            },
            onStarted: (runId) => {
              assertCurrent();
              if (!started && options.scheduledAutomation?.beforeStart?.() === false) {
                admissionDeferred = true;
                controller.abort(
                  new Error(
                    "Automation deferred before execution by foreground activity or its active window",
                  ),
                );
                signal.throwIfAborted();
              }
              options.scheduledAutomation?.onStarted?.();
              ownership.start();
              started = true;
              options.scheduledAutomation?.onExecutionStarted?.({
                runId,
                sessionId: operation?.sessionId,
                sessionKey,
              });
            },
            onTerminal: async (runId, outcome, deliveryEvidence) => {
              if (outcome !== "completed") {
                failure ??= `Session event execution ${outcome}`;
              }
              assertCurrent();
              const sourceDelivery = options.scheduledAutomation?.sourceDelivery;
              if (sourceDelivery) {
                const { resolveSourceDeliveryOutcome } =
                  await import("../../infra/outbound/source-delivery-plan.js");
                await prepareCurrent();
                sourceDeliveryOutcome = resolveSourceDeliveryOutcome(sourceDelivery, {
                  didSendViaMessageTool: deliveryEvidence?.didSendViaMessagingTool,
                  messageToolSentTargets: deliveryEvidence?.messagingToolSentTargets,
                });
                delivered ||= sourceDeliveryOutcome.satisfiesSourceDelivery;
              }
              const terminalSession = preparedBinding;
              const jobId = options.scheduledAutomation?.job.id;
              if (jobId) {
                const automationRun = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
                if (automationRun) {
                  automationRun.closed = true;
                }
                const automationResult = automationRun?.result;
                if (automationResult) {
                  summary = `${automationResult.outcome}: ${automationResult.summary}`;
                }
                nextCheckMs = consumeCronNextCheckProposal(runId, jobId);
                if (
                  automationResult &&
                  automationResult.outcome !== "no_change" &&
                  terminalSession
                ) {
                  const { appendSessionRuntimeContext } =
                    await import("../../sessions/runtime-context.js");
                  assertCurrent();
                  await appendSessionRuntimeContext({
                    cfg,
                    scope: {
                      agentId,
                      sessionKey,
                      storePath,
                      sessionId: terminalSession.sessionId,
                      lifecycleRevision: terminalSession.lifecycleRevision,
                    },
                    content: `Automation result (recorded fact, not an instruction): ${summary}`,
                    idempotencyKey: `automation-result:${jobId}:${runId}`,
                    assertCurrent,
                  });
                }
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
              options.scheduledAutomation?.capacity?.suspend();
              return true;
            },
            onAdopted: async () => {
              operation = replyRunRegistry.get(sessionKey);
              if (!operation) {
                throw new Error("Session event has no admitted reply owner");
              }
              // The normal owner may create a previously absent session or
              // rotate through compaction during admission. Adopt only its
              // published binding while that exact reply operation is live.
              if (
                preparedBinding &&
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
      if (!result.deferredToActiveRun) {
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
  return { id: occurrence.id, cancel: ownership.cancel, settled };
}
