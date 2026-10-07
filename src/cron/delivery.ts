/** Sends cron announce payloads and best-effort failure notifications. */

import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { resolveSessionStorePathCore } from "../config/sessions/inbound.runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import type { NormalizedOutboundPayload } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../shared/transcript-only-openclaw-assistant.js";
import "./delivery-plan.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  commitDirectCronOutboundRoute,
  projectDeliveredDirectCronPayloadsForMirror,
  resolveCronDeliveryRouteSessionKey,
  resolveDirectCronTranscriptMirrorText,
} from "./isolated-agent/delivery-dispatch-awareness.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
  readDirectCronDeliveryStatus,
  waitForCompletedDirectCronDelivery,
} from "./isolated-agent/delivery-dispatch-policy.js";
import {
  resolveDeliveryTarget,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronJob, CronMessageChannel } from "./types.js";
export { resolveCronDeliveryPlan } from "./delivery-plan.js";

/** Channel target metadata used for cron announcements and failure notifications. */
type CronAnnounceTarget = {
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
  sessionKey?: string;
  inheritSessionThread?: boolean;
};

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;
type CronAnnounceDeliveryOutcome =
  | Extract<
      Awaited<ReturnType<typeof sendDurableMessageBatchCore>>,
      { status: "sent" | "suppressed" }
    >
  // A retained receipt shows another attempt already delivered this occurrence.
  | { status: "completed" }
  // The occurrence was admitted earlier, but the queue can no longer show its outcome.
  | { status: "unknown"; reason: string };

async function resolveCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
}): Promise<
  | {
      ok: true;
      resolvedTarget: SuccessfulDeliveryTarget;
      session: ReturnType<typeof buildOutboundSessionContext>;
      identity: ReturnType<typeof resolveAgentOutboundIdentity>;
    }
  | { ok: false; error: Error }
> {
  // Resolve the target before building outbound identity/session so send errors
  // report the configured route, not only the cron job id.
  const targetResolutionOptions =
    params.target.inheritSessionThread === false ? { inheritSessionThread: false } : undefined;
  const resolvedTarget = await resolveDeliveryTarget(
    params.cfg,
    params.agentId,
    {
      channel: params.target.channel as CronMessageChannel | undefined,
      to: params.target.to,
      threadId: params.target.threadId,
      accountId: params.target.accountId,
      sessionKey: params.target.sessionKey,
    },
    targetResolutionOptions,
  );

  if (!resolvedTarget.ok) {
    return { ok: false, error: resolvedTarget.error };
  }

  const identity = resolveAgentOutboundIdentity(params.cfg, params.agentId);
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: resolveCronNotificationSessionKey({
      jobId: params.jobId,
      sessionKey: params.target.sessionKey,
    }),
  });

  return {
    ok: true,
    resolvedTarget,
    session,
    identity,
  };
}

/** Sends a cron announce payload and throws if target resolution or delivery fails. */
export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  payload: ReplyPayload;
  abortSignal: AbortSignal;
  completion?: {
    job: CronJob;
    runStartedAt: number;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
  };
  onDeliveryAttempt?: (reachedRecipient: boolean) => void;
}): Promise<CronAnnounceDeliveryOutcome> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  const fence = params.completion?.deliveryAttemptFence;
  const occurrenceAtMs = fence?.occurrenceAtMs ?? params.completion?.runStartedAt;
  const routeIntentId =
    occurrenceAtMs === undefined
      ? undefined
      : buildDirectCronDeliveryIdempotencyKey({
          jobId: params.jobId,
          occurrenceAtMs,
          delivery: delivery.resolvedTarget,
        });
  // In-run retries, outbound-queue replay, and the scheduler's retry run all
  // reuse this occurrence's one durable send instead of each queuing another.
  // An admitted intent stays the occurrence's send even if its route changed.
  const admittedIntentId = fence?.admittedIntentId;
  const deliveryIntentId = admittedIntentId ?? routeIntentId;
  const custody = deliveryIntentId
    ? await readDirectCronDeliveryStatus(deliveryIntentId)
    : undefined;
  if (custody === "completed") {
    return { status: "completed" };
  }
  // An admitted occurrence is never admitted again. Without queue custody its
  // outcome cannot be shown: the receipt may have been pruned, or a run could
  // not withdraw the admission of a send it never started.
  if (admittedIntentId && custody === undefined) {
    return {
      status: "unknown",
      reason:
        "an earlier attempt already queued this occurrence and its delivery record is gone; check the target, then run the job manually to send it again",
    };
  }
  const runSessionKey = resolveCronNotificationSessionKey({
    jobId: params.jobId,
    sessionKey: params.target.sessionKey,
  });
  // A send admitted under an earlier route still reaches that route's
  // recipient, so the current route's conversation gets no projection of it.
  const route =
    params.completion &&
    delivery.resolvedTarget.mode === "explicit" &&
    deliveryIntentId === routeIntentId
      ? (
          await resolveCronDeliveryRouteSessionKey({
            cfg: params.cfg,
            job: params.completion.job,
            agentId: params.agentId,
            agentSessionKey: runSessionKey,
            delivery: delivery.resolvedTarget,
            warningContext: "completion announcement mirror",
          })
        ).route
      : null;
  // Resolution can settle after its caller's deadline; never start plugin
  // delivery once the Gateway has released ownership of the timed-out work.
  params.abortSignal.throwIfAborted();
  const deliveryAttemptFence = params.completion?.deliveryAttemptFence;

  // Cron delivery is durable and non-best-effort for primary announces; partial
  // channel failure must surface as a cron run failure.
  let recipientReached = false;
  // An attempt that never reached the recipient and left its intent outside
  // queue custody ended before enqueue or was dropped unsent on abort. That is
  // proof of non-delivery, so release the admission and let a retry send it.
  const releaseUnsentAdmission = async () => {
    if (
      !deliveryIntentId ||
      !deliveryAttemptFence?.releaseAdmission ||
      recipientReached ||
      (await readDirectCronDeliveryStatus(deliveryIntentId)) !== undefined
    ) {
      return;
    }
    try {
      await deliveryAttemptFence.releaseAdmission(deliveryIntentId);
    } catch {
      // A refused release keeps the admission: a retry then reports Unknown
      // rather than risk sending the occurrence twice.
    }
  };
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  let send: Awaited<ReturnType<typeof sendDurableMessageBatchCore>>;
  try {
    await deliveryAttemptFence?.beforeAttempt(
      deliveryIntentId ? { intentId: deliveryIntentId } : undefined,
    );
    params.abortSignal.throwIfAborted();
    deliveryAttemptFence?.assertCurrent();
    send = await sendDurableMessageBatchCore({
      cfg: params.cfg,
      channel: delivery.resolvedTarget.channel,
      to: delivery.resolvedTarget.to,
      accountId: delivery.resolvedTarget.accountId,
      threadId: delivery.resolvedTarget.threadId,
      payloads: [params.payload],
      session: delivery.session,
      identity: delivery.identity,
      bestEffort: false,
      ...(deliveryIntentId
        ? {
            deliveryIntentId,
            reusePendingDeliveryIntent: true,
            completionRetention: DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
          }
        : {}),
      deps: createOutboundSendDeps(params.deps),
      signal: params.abortSignal,
      assertDirectAdapterHandoff: deliveryAttemptFence?.assertCurrent,
      ...(route ? { onPayload: (payload) => deliveredPayloads.push(payload) } : {}),
      onDeliveryResult: () => {
        if (!recipientReached) {
          recipientReached = true;
          params.onDeliveryAttempt?.(true);
        }
      },
    });
  } catch (error) {
    await releaseUnsentAdmission();
    throw error;
  }
  const mayHaveReachedRecipient = durableMessageBatchMayHaveReachedRecipient(send);
  if (!recipientReached) {
    params.onDeliveryAttempt?.(mayHaveReachedRecipient);
  }
  // Queue replay or another run can own the same intent while this attempt
  // runs; their completed receipt is this occurrence's delivery.
  if (
    deliveryIntentId &&
    send.status !== "sent" &&
    (await waitForCompletedDirectCronDelivery({
      id: deliveryIntentId,
      signal: params.abortSignal,
    }))
  ) {
    return { status: "completed" };
  }
  if (send.status !== "sent" && !mayHaveReachedRecipient) {
    await releaseUnsentAdmission();
  }
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  if (send.status === "sent" && route && params.completion && deliveryIntentId) {
    await commitDirectCronOutboundRoute({
      cfg: params.cfg,
      runSessionKey,
      delivery: delivery.resolvedTarget,
      route,
    });
    await appendAdmittedDirectCronDeliveryTranscriptMirror({
      job: params.completion.job,
      abortSignal: params.abortSignal,
      mirror: {
        config: params.cfg,
        sessionKey: route.sessionKey,
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.agentId,
        }),
        text: resolveDirectCronTranscriptMirrorText(
          projectDeliveredDirectCronPayloadsForMirror(deliveredPayloads),
        ),
        idempotencyKey: deliveryIntentId,
        deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
      },
    });
  }
  return send;
}
