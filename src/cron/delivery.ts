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
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  commitDirectCronOutboundRoute,
  projectDeliveredDirectCronPayloadsForMirror,
  resolveCronDeliveryRouteSessionKey,
  resolveDirectCronTranscriptMirrorText,
} from "./isolated-agent/delivery-dispatch-awareness.js";
import { buildDirectCronDeliveryIdempotencyKey } from "./isolated-agent/delivery-dispatch-policy.js";
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
type CronAnnounceDeliveryOutcome = Extract<
  Awaited<ReturnType<typeof sendDurableMessageBatchCore>>,
  { status: "sent" | "suppressed" }
>;

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
  completion?: { job: CronJob; runStartedAt: number };
  onDeliveryAttempt?: (reachedRecipient: boolean) => void;
}): Promise<CronAnnounceDeliveryOutcome> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  const runSessionKey = resolveCronNotificationSessionKey({
    jobId: params.jobId,
    sessionKey: params.target.sessionKey,
  });
  const route =
    params.completion && delivery.resolvedTarget.mode === "explicit"
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

  // Cron delivery is durable and non-best-effort for primary announces; partial
  // channel failure must surface as a cron run failure.
  let recipientReached = false;
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  const send = await sendDurableMessageBatchCore({
    cfg: params.cfg,
    channel: delivery.resolvedTarget.channel,
    to: delivery.resolvedTarget.to,
    accountId: delivery.resolvedTarget.accountId,
    threadId: delivery.resolvedTarget.threadId,
    payloads: [params.payload],
    session: delivery.session,
    identity: delivery.identity,
    bestEffort: false,
    deps: createOutboundSendDeps(params.deps),
    signal: params.abortSignal,
    ...(route ? { onPayload: (payload) => deliveredPayloads.push(payload) } : {}),
    onDeliveryResult: () => {
      if (!recipientReached) {
        recipientReached = true;
        params.onDeliveryAttempt?.(true);
      }
    },
  });
  if (!recipientReached) {
    params.onDeliveryAttempt?.(durableMessageBatchMayHaveReachedRecipient(send));
  }
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  if (send.status === "sent" && route && params.completion) {
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
        idempotencyKey: buildDirectCronDeliveryIdempotencyKey({
          jobId: params.jobId,
          runStartedAt: params.completion.runStartedAt,
          delivery: delivery.resolvedTarget,
        }),
        deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
      },
    });
  }
  return send;
}
