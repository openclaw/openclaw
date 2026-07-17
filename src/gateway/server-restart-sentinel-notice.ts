// Durable outbound notice ownership for restart-sentinel recovery.
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ackDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  withActiveDeliveryClaim,
} from "../infra/outbound/delivery-queue.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/restart-sentinel");

type RestartSentinelNoticeRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
};

export async function enqueueRestartSentinelNotice(
  params: RestartSentinelNoticeRoute & {
    message: string;
    sessionKey: string;
    revision: number;
  },
): Promise<{ id: string; created: boolean }> {
  return await enqueueDeliveryOnce(
    {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      replyToId: params.replyToId,
      threadId: params.threadId,
      payloads: [{ text: params.message }],
      bestEffort: false,
      completionRetention: "permanent",
    },
    `restart-sentinel-notice:${params.sessionKey}:${params.revision}`,
  );
}

export async function deliverRestartSentinelNotice(
  params: RestartSentinelNoticeRoute & {
    deps: CliDeps;
    cfg: OpenClawConfig;
    sessionKey: string;
    summary: string;
    message: string;
    queueId: string;
  },
): Promise<void> {
  const claim = await withActiveDeliveryClaim(params.queueId, async () => {
    try {
      const send = await sendDurableMessageBatch({
        cfg: params.cfg,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        payloads: [{ text: params.message }],
        session: buildOutboundSessionContext({ cfg: params.cfg, sessionKey: params.sessionKey }),
        deps: params.deps,
        bestEffort: false,
        skipQueue: true,
        deliveryQueueId: params.queueId,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      const results = send.status === "sent" ? send.results : [];
      if (results.length === 0) {
        throw new Error("outbound delivery returned no results");
      }
      await ackDelivery(params.queueId).catch(() => {});
    } catch (err) {
      // The send path records platform-attempt evidence on this queue row.
      // Durable recovery owns retries so ambiguous outcomes are reconciled
      // before another recipient-visible send can begin.
      await failDelivery(params.queueId, formatErrorMessage(err)).catch(() => undefined);
      log.warn(`${params.summary}: outbound delivery failed; queued for recovery: ${String(err)}`, {
        channel: params.channel,
        to: params.to,
        sessionKey: params.sessionKey,
      });
    }
  });
  if (claim.status === "claimed-by-other-owner") {
    log.info(`${params.summary}: durable restart notice claimed by recovery`, {
      sessionKey: params.sessionKey,
    });
  }
}
