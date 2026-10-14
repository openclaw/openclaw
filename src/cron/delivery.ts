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
import { outboundDeliveryQueueName } from "../infra/outbound/delivery-queue-namespaces.js";
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
  waitForCompletedDirectCronDelivery,
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
  | { status: "sent"; payloads: ReplyPayload[] }
  | { status: "suppressed"; reason: string; skipReason?: NormalizeReplySkipReason };

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
  const id = params.completion
    ? buildDirectCronDeliveryIdempotencyKey({
        jobId: params.jobId,
        runStartedAt: params.completion.runStartedAt,
        delivery,
      })
    : undefined;
  const queueName = outboundDeliveryQueueName({ sessionGeneration: params.sessionGeneration });
  if (id) {
    try {
      if (await isCompletedDirectCronDelivery(id, queueName)) {
        fence?.assertCurrent();
        params.onDeliveryAttempt?.(true);
        // Completed receipts retain no payload projection; never reconstruct one from new input.
        return { status: "sent", payloads: [] };
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
  return await retryTransientDirectCronDelivery({
    jobId: params.jobId,
    signal: params.abortSignal,
    shouldRetryError: () => !recipientReached,
    run: async () => {
      const deliveredPayloads: ReplyPayload[] = [];
      await fence?.beforeAttempt();
      params.abortSignal.throwIfAborted();
      fence?.assertCurrent();
      const result = await sendDurableMessageBatchCore(
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
          ...(id
            ? {
                deliveryIntentId: id,
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
      if (!recipientReached) {
        recipientReached = durableMessageBatchMayHaveReachedRecipient(result);
        params.onDeliveryAttempt?.(recipientReached);
      }
      if (
        result.status === "failed" &&
        id &&
        (await waitForCompletedDirectCronDelivery({
          id,
          queueName,
          signal: params.abortSignal,
        }))
      ) {
        fence?.assertCurrent();
        return { status: "sent" as const, payloads: deliveredPayloads };
      }
      if (result.status === "failed" || result.status === "partial_failed") {
        throw result.error;
      }
      return result.status === "sent"
        ? { status: "sent" as const, payloads: deliveredPayloads }
        : {
            status: "suppressed" as const,
            reason: recipientReached ? "adapter_returned_no_identity" : result.reason,
          };
    },
  });
}
