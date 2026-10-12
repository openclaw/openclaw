import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "../auto-reply/heartbeat-reply-payload.js";
import {
  selectHeartbeatToolResponse,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isHostNoticePayload,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { suppressPendingFinalDelivery } from "../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { resolveReplyOperationAbortReason } from "../auto-reply/reply/reply-operation-abort.js";
import {
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { resolveMessagingToolPayloadDedupe } from "../auto-reply/reply/reply-payloads-dedupe.js";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { resolveSourceReplyDeliveryMode } from "../auto-reply/reply/source-reply-delivery-mode.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import {
  isDeliveryRecoveryOwnedRetry,
  resolveDeliveryNotSentRetryability,
} from "./delivery-recovery.shared.js";
import { formatErrorMessage } from "./errors.js";
import { readExecRequestOwners } from "./exec-request-context.js";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";
import { isExecCompletionSystemEvent } from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import { persistHeartbeatOutcome } from "./heartbeat-outcome-store.js";
import { resolveHeartbeatChannelPlugin } from "./heartbeat-runner-config.js";
import type {
  HeartbeatRunOptions,
  PreparedHeartbeatRun,
  ReadyHeartbeatWake,
} from "./heartbeat-runner-execution.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";
import { restoreHeartbeatUpdatedAt } from "./heartbeat-runner-session.js";
import {
  prepareHeartbeatTargetAwareness,
  publishHeartbeatSessionReply,
} from "./heartbeat-session-publication.js";
import {
  HEARTBEAT_IDLE_RETRY_GRACE_MS,
  HEARTBEAT_SKIP_CHANNEL_NOT_READY,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import { isOutboundDeliveryError } from "./outbound/deliver-types.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  holdSystemEventDelivery,
  peekDeliverableSystemEventEntries,
} from "./system-events.js";

type HeartbeatDispatch = {
  opts: HeartbeatRunOptions;
  wake: ReadyHeartbeatWake;
  prepared: PreparedHeartbeatRun;
  result?: HeartbeatRunResult;
  runSession?: { sessionKey: string; sessionId: string };
  deliveryError?: string;
  retryUnqueuedDelivery?: boolean;
  execDeliveryOutcome?: "delivered" | "recovery-owned" | "unknown-after-send" | "rejected";
  deliveryReason?: string;
  deliverySilent?: boolean;
  projectTarget?: boolean;
  publicationSourceText?: string;
  prepareReply: NonNullable<ReplyOperationRunState["heartbeat"]>["prepareReply"];
};

export function createHeartbeatDispatch(
  opts: HeartbeatRunOptions,
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
): HeartbeatDispatch {
  const policy: HeartbeatDispatch = {
    opts,
    wake,
    prepared,
    prepareReply: (result, state) => prepareHeartbeatDispatchReply(policy, result, state),
  };
  return policy;
}

const FIRST_HEARTBEAT_ALERT_PREAMBLE =
  'First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention. Run `openclaw config set agents.defaults.heartbeat.target "none"` to keep these internal.';
/** Monitoring decides which final is public before ordinary dispatch can send it. */
async function prepareHeartbeatDispatchReply(
  policy: HeartbeatDispatch,
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
  runState: ReplyOperationRunState,
): ReturnType<HeartbeatDispatch["prepareReply"]> {
  const { opts, wake, prepared } = policy;
  const { cfg, agentId, startedAt, preflight, scheduledTasks, wakeSource } = wake;
  const { delivery, visibility, sessionKey, storePath, runSessionKey, previousUpdatedAt } =
    prepared;
  const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
  // A continuation under a quiet heartbeat posts the model's reply, never host notices;
  // its terminal failure then stays silent.
  const selected = resolveHeartbeatReplyPayload(
    prepared.quietHostNotices
      ? replies.filter((reply) => !isHostNoticePayload(reply))
      : replyResult,
  );
  const execution = resolveReplyOperationAgentTurn(runState);
  const heartbeatResponse = selectHeartbeatToolResponse(replyResult);
  const response = heartbeatResponse?.response;
  // Admission can lose to foreground work after preflight. An empty rejected
  // turn must leave its events queued, unlike a completed quiet turn.
  const admissionBusy =
    runState.admission?.status === "skipped" &&
    runState.admission.reason === "active-run" &&
    !response &&
    (!selected || !hasOutboundReplyContent(selected));
  const execCancelled = () =>
    prepared.inspectedSystemEventsToConsume.some((event) =>
      readExecRequestOwners(event)?.some((owner) => owner.signal.aborted),
    );
  if (execution === "cancelled" || execution === "superseded" || admissionBusy || execCancelled()) {
    const reason =
      execution === "superseded"
        ? "preempted"
        : execution === "cancelled"
          ? "agent-runner-cancelled"
          : HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT;
    policy.result = { status: "skipped", reason };
    emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
    return {};
  }
  const channel = delivery.channel !== "none" ? delivery.channel : undefined;
  const committed = resolveMessagingToolPayloadDedupe({
    config: cfg,
    messageProvider: channel,
    originatingTo: delivery.to,
    originatingThreadId: delivery.threadId,
    accountId: delivery.accountId,
    messagingToolSentTargets: runState.messagingToolSentTargets,
  });
  const failure = resolveHeartbeatTerminalToolFailure(replyResult);
  const responsePrefix = resolveResponsePrefixTemplate(
    prepared.replyPrefix.responsePrefix,
    prepared.replyPrefix.responsePrefixContextProvider(),
  );
  const outcome = classifyHeartbeatAgentOutcome({
    agentRun: {
      agentRunFailed: execution === "failed",
      heartbeatToolResponse: response,
      heartbeatTerminalToolFailure: failure,
      replyPayload: selected,
    },
    useHeartbeatFailureCopy: prepared.useHeartbeatFailureCopy,
    hasRelayableExecCompletion: prepared.hasRelayableExecCompletion,
    suppressUnmarkedSourceReplies:
      resolveSourceReplyDeliveryMode({
        cfg,
        ctx: { ChatType: delivery.chatType, Provider: delivery.channel },
      }) === "message_tool_only",
    responsePrefix,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  });
  const scratch =
    outcome.kind === "failure" || !heartbeatResponse
      ? undefined
      : getReplyPayloadMetadata(heartbeatResponse.payload)?.heartbeatScratchProposal;
  if (scratch !== undefined && response) {
    if (!preflight.scratchJobId) {
      log.warn("heartbeat: scratch update ignored because no monitor job exists");
    } else {
      try {
        const owner = runState.agentTurnOwner;
        const written = await writeCronJobScratch(
          {
            storePath: resolveCronJobsStorePathFromConfig(cfg),
            jobId: preflight.scratchJobId,
            content: scratch,
            expectedRevision: preflight.scratchRevision ?? 0,
          },
          {
            assertCurrent() {
              if (runState.agentTurnOwner !== owner || resolveReplyOperationAbortReason(owner)) {
                throw new Error("Heartbeat scratch writer is no longer current");
              }
            },
          },
        );
        if (!written.ok) {
          log.warn("heartbeat: scratch update lost a concurrent revision race");
        }
      } catch (error) {
        log.warn(`heartbeat: scratch update failed: ${formatErrorMessage(error)}`);
      }
    }
  }
  // Quiet and unselected payloads never acquire delivery custody. Their exact prepared
  // intents may retire; queued or unknown recovery ownership is untouched.
  for (const reply of replies) {
    if (
      (execution !== "failed" && response?.notify === false) ||
      (reply !== selected && outcome.kind !== "failure")
    ) {
      await suppressPendingFinalDelivery(reply, { preserveActivity: true });
    }
  }
  // A delivered failure notice does not complete the work whose model turn failed.
  const completedExecTurn = prepared.hasExecCompletion && outcome.kind !== "failure";
  const finish = (event: Parameters<typeof emitHeartbeatEvent>[0], consume = true) => {
    emitHeartbeatEvent({
      ...event,
      ...(committed.matchingRoute && event.silent === true ? { silent: false } : {}),
      durationMs: Date.now() - startedAt,
      accountId: delivery.accountId,
    });
    const queueKey = resolveSystemEventQueueKey(sessionKey, agentId);
    // Stop cannot revoke a confirmed send or transfer recovery's existing custody
    // to a newly generated reply for the surviving occurrences.
    const settleEvents =
      !execCancelled() ||
      (policy.execDeliveryOutcome !== undefined && policy.execDeliveryOutcome !== "rejected");
    if (completedExecTurn && preflight.shouldInspectPendingEvents && !consume) {
      const execEvents = prepared.inspectedSystemEventsToConsume.filter(
        isExecCompletionSystemEvent,
      );
      if (policy.execDeliveryOutcome && settleEvents) {
        consumeSelectedSystemEventEntries(queueKey, execEvents);
      } else if (
        !policy.execDeliveryOutcome &&
        policy.deliveryError &&
        !policy.retryUnqueuedDelivery
      ) {
        holdSystemEventDelivery(queueKey, execEvents);
      }
    }
    if (consume && settleEvents && preflight.shouldInspectPendingEvents) {
      consumeSelectedSystemEventEntries(resolveSystemEventQueueKey(sessionKey, agentId), [
        ...prepared.inspectedSystemEventsToConsume,
        ...prepared.deferredGenericEvents,
      ]);
      if (prepared.hasExecCompletion && prepared.hasCronEvents) {
        // Coalesced waiters share this turn, but exec and cron retain separate prompt/delivery policy.
        requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason: "cron:pending",
          agentId,
          sessionKey,
          heartbeat: wake.heartbeat && {
            ...(wake.heartbeat.target !== undefined ? { target: wake.heartbeat.target } : {}),
            ...(wake.heartbeat.to !== undefined ? { to: wake.heartbeat.to } : {}),
            ...(wake.heartbeat.accountId !== undefined
              ? { accountId: wake.heartbeat.accountId }
              : {}),
          },
        });
      }
    }
    if (
      completedExecTurn &&
      settleEvents &&
      (consume ||
        policy.execDeliveryOutcome ||
        (policy.deliveryError && !policy.retryUnqueuedDelivery)) &&
      preflight.deferredEventEntries.length > 0
    ) {
      const next = peekDeliverableSystemEventEntries(queueKey);
      if (next.length > 0) {
        const source = next.some(isExecCompletionSystemEvent)
          ? "exec-event"
          : next.some((entry) => entry.contextKey?.startsWith("cron:"))
            ? "cron"
            : "hook";
        requestHeartbeat({
          source,
          intent: source === "exec-event" ? "event" : "immediate",
          reason: source === "exec-event" ? source : source + ":pending",
          heartbeat: wake.heartbeat,
          agentId,
          sessionKey,
        });
      }
    }
    policy.result =
      outcome.kind === "failure"
        ? { status: "failed", reason: outcome.reason }
        : { status: "ran", durationMs: Date.now() - startedAt, ...policy.runSession };
    return {};
  };
  const stateKey = prepared.outboundPolicySessionKey ?? sessionKey;
  const record = (value: HeartbeatToolResponse) =>
    persistHeartbeatOutcome({
      agentId,
      sessionKey: stateKey,
      storePath,
      runSessionKey,
      response: value,
      taskNames: scheduledTasks.map((task) => task.name),
      wakeSource,
      wakeReason: opts.reason,
      occurredAt: startedAt,
    });
  const unconfirmed = async (reason: string) => {
    if (outcome.kind !== "delivery" || !outcome.response) {
      return;
    }
    const value = outcome.response;
    await record({
      ...value,
      outcome: "blocked",
      notify: false,
      summary: `Alert delivery was not confirmed for this attempt.\n${value.notificationText ?? value.summary}${value.notificationText ? `\nModel summary: ${value.summary}` : ""}`,
      reason: `notify:true; delivery=${reason}; model outcome=${value.outcome}; ${value.reason ?? value.summary}`,
    });
  };
  const restoreActivity = () =>
    restoreHeartbeatUpdatedAt({ agentId, storePath, sessionKey, updatedAt: previousUpdatedAt });
  const suppressSelected = () => suppressPendingFinalDelivery(selected, { preserveActivity: true });
  const checkReady = (onError: (error: unknown) => { ok: false; reason?: string }) =>
    channel
      ? resolveHeartbeatChannelPlugin(channel)
          ?.heartbeat?.checkReady?.({ cfg, accountId: delivery.accountId, deps: opts.deps })
          .catch(onError)
      : undefined;
  const deliveryRetry = (): HeartbeatRunResult => ({
    status: "skipped",
    reason: HEARTBEAT_SKIP_CHANNEL_NOT_READY,
    retryAtMs: Date.now() + HEARTBEAT_IDLE_RETRY_GRACE_MS,
  });
  if (outcome.kind === "ack") {
    if ("response" in outcome && outcome.response) {
      await record(outcome.response);
    }
    await restoreActivity();
    await suppressSelected();
    const aborted = resolveReplyOperationAbortReason(runState.agentTurnOwner);
    if (aborted) {
      const reason = aborted === "superseded" ? "preempted" : "agent-runner-cancelled";
      policy.result = { status: "skipped", reason };
      emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
      return {};
    }
    if (committed.matchingRoute) {
      return finish({
        status: "sent",
        to: delivery.to,
        preview: truncateHeartbeatPreview(committed.routeSentTexts.join("\n")),
        hasMedia: committed.routeSentMediaUrls.length > 0,
        channel,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
        silent: false,
      });
    }
    if (runState.backgroundWorkStarted) {
      return finish({
        status: "skipped",
        reason: "background-work",
        message: "Heartbeat started background work; completion is tracked separately.",
        channel,
        silent: true,
      });
    }
    const event = {
      status: outcome.eventStatus,
      reason: opts.reason,
      ...("preview" in outcome ? { preview: outcome.preview } : {}),
      channel,
      indicatorType: visibility.useIndicator
        ? resolveIndicatorType(outcome.eventStatus)
        : undefined,
    };
    if (!("silent" in outcome && outcome.silent) && visibility.showOk && channel && delivery.to) {
      const readiness = await checkReady((error) => {
        log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${formatErrorMessage(error)}`);
        return { ok: false };
      });
      if (!readiness || readiness.ok) {
        return {
          reply: setReplyPayloadMetadata(
            { text: responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN },
            {
              heartbeatReply: true,
              deliverDespiteSourceReplySuppression: true,
            },
          ),
          settle: async (result) => {
            if (policy.deliveryError) {
              log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${policy.deliveryError}`);
            }
            finish({ ...event, silent: result !== "delivered" });
          },
        };
      }
    }
    return finish({ ...event, silent: true });
  }
  const stateEntry = prepared.policySessionEntry;
  const failed = outcome.kind === "failure";
  const normalized = outcome.normalized;
  const text = normalized.text;
  const preview = truncateHeartbeatPreview(failed ? text || outcome.previewText : text);
  const event = {
    status: failed ? ("failed" as const) : ("sent" as const),
    ...(failed ? { reason: outcome.reason } : {}),
    preview,
    channel,
    indicatorType: failed && visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
  };
  if (failed) {
    await restoreActivity();
  } else {
    const previousAt = stateEntry?.lastHeartbeatSentAt;
    if (
      !prepared.internalProjection &&
      !prepared.hasExecCompletion &&
      !outcome.mediaUrls.length &&
      !outcome.hasStructuredReplyContent &&
      stateEntry?.lastHeartbeatText?.trim() &&
      text.trim() === stateEntry.lastHeartbeatText.trim() &&
      typeof previousAt === "number" &&
      previousAt <= startedAt &&
      startedAt - previousAt < 24 * 60 * 60 * 1000
    ) {
      await restoreActivity();
      await suppressSelected();
      return finish({ status: "skipped", reason: "duplicate", preview, hasMedia: false, channel });
    }
  }
  const noChannelTarget = !prepared.internalProjection && (!channel || !delivery.to);
  if (noChannelTarget || !visibility.showAlerts || (failed && outcome.shouldSkipMain)) {
    if (!failed) {
      await unconfirmed(noChannelTarget ? (delivery.reason ?? "no-target") : "alerts-disabled");
      if (!visibility.showAlerts) {
        await restoreActivity();
      }
      await suppressSelected();
    }
    return finish(
      failed
        ? { ...event, silent: true }
        : {
            ...event,
            status: "skipped",
            reason: noChannelTarget ? (delivery.reason ?? "no-target") : "alerts-disabled",
            hasMedia: outcome.mediaUrls.length > 0,
            indicatorType:
              !noChannelTarget && visibility.useIndicator
                ? resolveIndicatorType("sent")
                : undefined,
          },
      !failed,
    );
  }
  const readiness = channel
    ? await checkReady((error) => ({ ok: false, reason: formatErrorMessage(error) }))
    : undefined;
  if (readiness && !readiness.ok) {
    await unconfirmed(readiness.reason ?? HEARTBEAT_SKIP_CHANNEL_NOT_READY);
    await restoreActivity();
    finish(
      {
        ...event,
        status: failed ? "failed" : "skipped",
        reason: failed ? outcome.reason : readiness.reason,
        ...(failed ? { silent: true } : {}),
      },
      false,
    );
    if (!failed) {
      policy.result = deliveryRetry();
    }
    return {};
  }
  policy.deliverySilent = normalized.silent;
  policy.projectTarget = !failed;
  // Receipt identity uses the producer answer, not transport prefix decoration.
  policy.publicationSourceText = outcome.replyPayload?.text;
  const deliveryText =
    !failed && delivery.implicitDefaultRoute && stateEntry?.lastHeartbeatSentAt === undefined
      ? `${FIRST_HEARTBEAT_ALERT_PREAMBLE}\n${text}`
      : text;
  const payload = copyReplyPayloadMetadata(selected ?? {}, {
    ...outcome.replyPayload,
    text: deliveryText || undefined,
    ...(!failed ? { mediaUrls: outcome.mediaUrls } : {}),
  });
  return {
    reply: setReplyPayloadMetadata(markReplyPayloadForSourceSuppressionDelivery(payload), {
      heartbeatReply: true,
    }),
    settle: async (result) => {
      const sent = result === "delivered";
      if (!sent) {
        await unconfirmed(policy.deliveryError ?? policy.deliveryReason ?? result);
      }
      if (sent && !failed && deliveryText.trim()) {
        await patchSessionEntryCore(
          { agentId, storePath, sessionKey: stateKey },
          (current, context) =>
            (
              context.existingEntry
                ? current.sessionId === stateEntry?.sessionId &&
                  current.lifecycleRevision === stateEntry?.lifecycleRevision
                : stateEntry === undefined
            )
              ? { lastHeartbeatText: text, lastHeartbeatSentAt: startedAt }
              : null,
          {
            fallbackEntry: mergeSessionEntry(undefined, { updatedAt: startedAt }),
            preserveActivity: true,
          },
        );
      }
      finish(
        failed
          ? { ...event, silent: !sent || normalized.silent === true }
          : {
              ...event,
              status: sent ? "sent" : policy.deliveryError ? "failed" : "skipped",
              indicatorType: visibility.useIndicator
                ? resolveIndicatorType(sent ? "sent" : policy.deliveryError ? "failed" : "skipped")
                : undefined,
              ...(!sent ? { reason: policy.deliveryError ?? policy.deliveryReason ?? result } : {}),
              to: delivery.to,
              preview: truncateHeartbeatPreview(deliveryText),
              hasMedia: outcome.mediaUrls.length > 0,
              ...(normalized.silent === true ? { silent: true } : {}),
            },
        sent && !failed,
      );
      if (!failed && policy.retryUnqueuedDelivery) {
        policy.result = deliveryRetry();
      } else if (policy.deliveryError && !failed) {
        policy.result = { status: "failed", reason: policy.deliveryError };
      }
    },
  };
}

/** The core dispatcher owns custody; monitoring supplies its existing transport policy. */
export async function deliverHeartbeatDispatch(
  policy: HeartbeatDispatch,
  payload: ReplyPayload,
  signal?: AbortSignal,
) {
  const { cfg, agentId, startedAt } = policy.wake;
  const { delivery, runSessionKey, storePath, outboundPolicySessionKey, internalProjection } =
    policy.prepared;
  const onDeliveredPayload = policy.projectTarget
    ? prepareHeartbeatTargetAwareness({
        agentId,
        storePath,
        runSessionKey,
        targetSessionKey: delivery.targetSessionKey,
        startedAt,
      })
    : undefined;
  let publishedIntent = false;
  let platformDispatchStarted = false;
  const hasPendingFinalOwner = Boolean(resolvePendingFinalDeliveryCompletion([payload]));
  try {
    if (delivery.channel === "none" || !delivery.to) {
      // A failed attempt does not own the successful completion's receipt identity.
      if (!internalProjection || policy.projectTarget === false) {
        return { visibleReplySent: false };
      }
      // Restart continuations are admitted as generic prompt text, so their queue
      // identities join the publication key alongside inspected completions.
      const occurrenceIds = [
        ...policy.prepared.inspectedSystemEventsToConsume,
        ...policy.prepared.deferredGenericEvents,
      ].map((event) => event.id);
      if (!occurrenceIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
        policy.deliveryReason = "exec completion occurrence identity unavailable";
        return { visibleReplySent: false };
      }
      const committed = await publishHeartbeatSessionReply({
        cfg,
        agentId,
        storePath,
        sessionKey: internalProjection.sessionKey,
        expectedGeneration: internalProjection,
        occurrenceIds,
        payload,
        sourceText: policy.publicationSourceText,
        signal,
      });
      if (!committed.ok) {
        policy.deliveryReason = committed.reason;
      } else {
        policy.execDeliveryOutcome = "delivered";
      }
      // Settlement consumes only captured occurrences, and only after the
      // canonical transcript owner accepts this generation's write or replay.
      return { visibleReplySent: committed.ok };
    }
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      threadId: delivery.threadId,
      payloads: [payload],
      session: buildOutboundSessionContext({
        cfg,
        agentId,
        sessionKey: runSessionKey,
        policySessionKey: outboundPolicySessionKey,
      }),
      identity: resolveAgentOutboundIdentity(cfg, agentId),
      deps: policy.opts.deps,
      signal,
      silent: policy.deliverySilent,
      onDeliveredPayload,
      onDeliveryIntent: () => {
        publishedIntent = true;
      },
      onPlatformSendDispatch: async () => {
        platformDispatchStarted = true;
      },
    });
    if (send.status === "failed" || send.status === "partial_failed") {
      throw send.error;
    }
    if (policy.projectTarget !== false) {
      if (send.status === "sent") {
        policy.execDeliveryOutcome = "delivered";
      } else if (send.status === "suppressed" && send.reason === "adapter_returned_no_identity") {
        policy.execDeliveryOutcome = "unknown-after-send";
      }
    }
    if (send.status === "suppressed") {
      policy.deliveryReason = send.reason;
    }
    return {
      visibleReplySent: send.status === "sent",
      ...(send.status === "suppressed" && send.reason === "adapter_returned_no_identity"
        ? { ambiguous: true }
        : {}),
    };
  } catch (error) {
    policy.deliveryError = formatErrorMessage(error);
    policy.execDeliveryOutcome =
      policy.projectTarget === false
        ? undefined
        : isDeliveryRecoveryOwnedRetry(error)
          ? "recovery-owned"
          : publishedIntent &&
              isOutboundDeliveryError(error) &&
              error.queueCustody === "released" &&
              resolveDeliveryNotSentRetryability(error) === false
            ? "rejected"
            : undefined;
    // Uncertain publication retains recovery custody even before the intent callback.
    // A cancelled, unpublished direct send settles its claimed final without replay;
    // published cancellation additionally needs the queue owner's released custody.
    policy.retryUnqueuedDelivery =
      policy.prepared.hasExecCompletion &&
      !policy.execDeliveryOutcome &&
      !platformDispatchStarted &&
      ((!publishedIntent && (!hasPendingFinalOwner || signal?.aborted === true)) ||
        (signal?.aborted === true &&
          isOutboundDeliveryError(error) &&
          error.queueCustody === "released"));
    throw error;
  }
}
