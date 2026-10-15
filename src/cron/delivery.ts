/** Channel notifications share one durable send path; conversation results have a separate owner. */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import { createChannelReplyTransform } from "../channels/message/reply-transform.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../channels/registry-normalize.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { SessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode } from "../config/types.tts.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { outboundDeliveryQueueName } from "../infra/outbound/delivery-queue-namespaces.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../interactive/payload.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
  isCompletedDirectCronDelivery,
  logCronDeliveryWarn,
  maybeApplyTtsToCronPayloads,
  retryTransientDirectCronDelivery,
  waitForDirectCronDeliveryOwner,
} from "./isolated-agent/delivery-dispatch-policy.js";
import {
  appendCronRunInspectionLink,
  normalizeDirectCronDeliveryPayloads,
} from "./isolated-agent/delivery-payload-normalization.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";
export { resolveCronDeliveryPlan } from "./delivery-plan.js";

type CronAnnounceTarget = {
  channel: string;
  to: string;
  threadId?: string | number;
  accountId?: string;
  sessionKey?: string;
};

type CronAnnounceResult =
  // `earlierRoute`: the occurrence's send was admitted under a route the job has
  // since left; the queue keeps its original recipient, so no current
  // conversation owns the result.
  | { status: "sent"; payloads: ReplyPayload[]; earlierRoute?: true }
  | { status: "suppressed"; reason: string; skipReason?: NormalizeReplySkipReason }
  // The occurrence was admitted earlier, but the queue can no longer show its outcome.
  | { status: "unknown"; reason: string };

/** Sends only the configured notification. It never selects or writes a model transcript. */
export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  payload: ReplyPayload | ReplyPayload[];
  abortSignal: AbortSignal;
  bestEffort?: boolean;
  tts?: { auto?: TtsAutoMode };
  inspectionUrl?: string;
  sessionGeneration?: SessionDeliveryGeneration;
  completion?: {
    job: CronJob;
    runStartedAt: number;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    /**
     * Command and script announcements deliver their scheduled occurrence once:
     * in-run retries, queue replay, and the scheduler's retry runs share one
     * admitted intent.
     */
    admitsOccurrence?: true;
  };
  onDeliveryAttempt?: (reachedRecipient: boolean) => void;
}): Promise<CronAnnounceResult> {
  const delivery = params.target;
  params.abortSignal.throwIfAborted();
  const channelId = normalizeAnyChannelId(delivery.channel) ?? delivery.channel;
  const transform = createChannelReplyTransform({
    cfg: params.cfg,
    accountId: delivery.accountId,
    messaging: getLoadedChannelPluginForRead(channelId)?.messaging,
  });
  const normalized = normalizeDirectCronDeliveryPayloads({
    deliveryPayloads: Array.isArray(params.payload) ? params.payload : [params.payload],
    channelTransform: transform ? { apply: transform } : undefined,
  });
  if (normalized.kind === "suppress") {
    return { status: "suppressed", reason: normalized.reason, skipReason: normalized.reason };
  }
  const fence = params.completion?.deliveryAttemptFence;
  const occurrence = params.completion?.admitsOccurrence ? (fence ?? null) : null;
  const id = params.completion
    ? buildDirectCronDeliveryIdempotencyKey({
        jobId: params.jobId,
        atMs: occurrence?.occurrenceAtMs ?? params.completion.runStartedAt,
        delivery,
      })
    : undefined;
  const queueName = outboundDeliveryQueueName({ sessionGeneration: params.sessionGeneration });
  // Completed receipts retain no payload projection; never reconstruct one from new input.
  const completed = (intentId: string) => {
    fence?.assertCurrent();
    params.onDeliveryAttempt?.(true);
    return intentId === id
      ? { status: "sent" as const, payloads: [] }
      : { status: "sent" as const, payloads: [], earlierRoute: true as const };
  };
  if (id && !occurrence) {
    try {
      if (await isCompletedDirectCronDelivery(id, queueName)) {
        return completed(id);
      }
    } catch (error) {
      if (!params.bestEffort) {
        throw error;
      }
      await logCronDeliveryWarn(
        `[cron:${params.jobId}] delivery receipt unavailable; continuing best-effort notification`,
      );
    }
  }
  const prepared = params.tts
    ? await maybeApplyTtsToCronPayloads({
        cfg: params.cfg,
        payloads: normalized.payload,
        delivery,
        agentId: params.agentId,
        ttsAuto: params.tts.auto,
      })
    : normalized.payload;
  const payloads = appendCronRunInspectionLink(
    prepared.filter((payload) => hasReplyPayloadContent(payload, { trimText: true })),
    params.inspectionUrl,
  );
  if (payloads.length === 0) {
    return { status: "suppressed", reason: "empty_after_tts" };
  }
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: resolveCronNotificationSessionKey({
      jobId: params.jobId,
      sessionKey: params.target.sessionKey,
    }),
  });
  const identity = resolveAgentOutboundIdentity(params.cfg, params.agentId);
  let recipientReached = false;
  return await retryTransientDirectCronDelivery<CronAnnounceResult>({
    jobId: params.jobId,
    signal: params.abortSignal,
    shouldRetryError: () => !recipientReached,
    run: async () => {
      // Each attempt reads the occurrence's admission as it stands: an earlier
      // attempt or run may have admitted it, or this run may have released it.
      const admittedIntentId = occurrence?.admittedIntentId;
      const intentId = admittedIntentId ?? id;
      if (occurrence && intentId) {
        const custody = (await findDeliveryIntentOwner(intentId))?.status;
        if (custody === "completed") {
          return completed(intentId);
        }
        // A failed record keeps no evidence of whether a send reached the
        // recipient, and the queue never sends it again.
        if (custody === "failed") {
          return {
            status: "unknown",
            reason:
              "the outbound queue gave up on this occurrence's send; check the target, then run the job manually to send it again",
          };
        }
        // An admitted occurrence is never admitted again. Without queue custody
        // its outcome cannot be shown: the receipt may have been pruned, or a run
        // could not withdraw the admission of a send it never started.
        if (admittedIntentId && custody === undefined) {
          return {
            status: "unknown",
            reason:
              "an earlier attempt already queued this occurrence and its delivery record is gone; check the target, then run the job manually to send it again",
          };
        }
      }
      // An attempt that never reached the recipient and left its intent outside
      // queue custody ended before enqueue or was dropped unsent on abort. That
      // is proof of non-delivery, so release the admission and let a retry send it.
      const releaseUnsentAdmission = async () => {
        if (!occurrence?.releaseAdmission || !intentId || recipientReached) {
          return;
        }
        try {
          if (!(await findDeliveryIntentOwner(intentId))) {
            await occurrence.releaseAdmission(intentId);
          }
        } catch {
          // A failed or refused release keeps the admission: a retry then
          // reports Unknown rather than risk sending the occurrence twice.
        }
      };
      const deliveredPayloads: ReplyPayload[] = [];
      let result: Awaited<ReturnType<typeof sendDurableMessageBatchCore>>;
      try {
        await fence?.beforeAttempt(occurrence && intentId ? { intentId } : undefined);
        params.abortSignal.throwIfAborted();
        fence?.assertCurrent();
        result = await sendDurableMessageBatchCore(
          {
            cfg: params.cfg,
            channel: delivery.channel,
            to: delivery.to,
            accountId: delivery.accountId,
            threadId: delivery.threadId,
            payloads,
            session,
            identity,
            bestEffort: params.bestEffort === true,
            durability: params.bestEffort === true ? "best_effort" : "required",
            ...(intentId
              ? {
                  deliveryIntentId: intentId,
                  reusePendingDeliveryIntent: true,
                  completionRetention: DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
                }
              : {}),
            deps: createOutboundSendDeps(params.deps),
            signal: params.abortSignal,
            assertDirectAdapterHandoff: fence?.assertCurrent,
            onDeliveredPayload: ({ hookContent, ...payload }) =>
              deliveredPayloads.push({ ...payload, spokenText: hookContent }),
            onDeliveryResult: () => {
              if (!recipientReached) {
                recipientReached = true;
                params.onDeliveryAttempt?.(true);
              }
            },
          },
          undefined,
          undefined,
          params.sessionGeneration,
        );
      } catch (error) {
        await releaseUnsentAdmission();
        throw error;
      }
      if (!recipientReached) {
        recipientReached = durableMessageBatchMayHaveReachedRecipient(result);
        params.onDeliveryAttempt?.(recipientReached);
      }
      const sent = (): CronAnnounceResult =>
        intentId === id
          ? { status: "sent", payloads: deliveredPayloads }
          : { status: "sent", payloads: [], earlierRoute: true };
      // Before the wait, which rejects once the run aborts; a release needs the
      // queue to hold no record, so no concurrent owner can complete the intent.
      if (result.status !== "sent") {
        await releaseUnsentAdmission();
      }
      // The queue hands an occurrence's send to the intent's current owner,
      // such as queue recovery, and returns no result; that owner settles it.
      const handedOff =
        occurrence !== null &&
        result.status === "suppressed" &&
        result.reason === "no_visible_result" &&
        !recipientReached;
      const ownerOutcome =
        (result.status === "failed" || handedOff) && intentId
          ? await waitForDirectCronDeliveryOwner({
              id: intentId,
              queueName,
              signal: params.abortSignal,
            })
          : undefined;
      if (ownerOutcome === "completed") {
        fence?.assertCurrent();
        return sent();
      }
      if (handedOff) {
        // That owner's attempt ended unsent and left the send queued; retry it
        // like this attempt's own unsent failure.
        if (ownerOutcome === "unsent") {
          throw new PlatformMessageNotDispatchedError(
            "another delivery attempt of this occurrence ended unsent",
            { cause: undefined },
          );
        }
        return {
          status: "unknown",
          reason:
            "another delivery of this occurrence was still in progress; check the target before running the job manually",
        };
      }
      if (result.status === "failed" || result.status === "partial_failed") {
        throw result.error;
      }
      return result.status === "sent"
        ? sent()
        : {
            status: "suppressed",
            reason: recipientReached ? "adapter_returned_no_identity" : result.reason,
          };
    },
  });
}
