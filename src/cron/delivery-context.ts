/** Converts live or stored session routing into cron delivery config. */
import { requesterCreatorProfileId, type RequesterOrigin } from "../agents/requester-origin.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import {
  cronDeliveryUsesDefaultDestination,
  resolveCronDefaultDeliveryDestination,
} from "./delivery-defaults.js";
import type { CronDelivery, CronMessageChannel } from "./types.js";

function isInternalDeliveryContext(context?: DeliveryContext): boolean {
  const channel = context?.channel?.trim().toLowerCase();
  return Boolean(
    channel && (channel === INTERNAL_MESSAGE_CHANNEL || isInternalNonDeliveryChannel(channel)),
  );
}

/** Converts an active delivery context into cron announce delivery config. */
function cronDeliveryFromContext(context?: DeliveryContext): CronDelivery | null {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.to) {
    return null;
  }
  // Internal conversation coordinates are not outbound channel targets.
  if (isInternalDeliveryContext(normalized)) {
    return null;
  }
  const delivery: CronDelivery = {
    mode: "announce",
    to: normalized.to,
  };
  if (normalized.channel) {
    delivery.channel = normalized.channel as CronMessageChannel;
  }
  if (normalized.accountId) {
    delivery.accountId = normalized.accountId;
  }
  if (normalized.threadId != null) {
    delivery.threadId = normalized.threadId;
  }
  return delivery;
}

/** Recovers delivery context from a stored session key captured when the cron job was created. */
export async function resolveCronStoredDeliveryContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<DeliveryContext | undefined> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const { deliveryContext, threadId } = await extractDeliveryInfo(sessionKey, {
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (deliveryContext && threadId) {
    // Parsed session-key thread ids are canonical; replace any stale thread value in stored context.
    return { ...deliveryContext, threadId };
  }
  return deliveryContext;
}

/** Resolves initial cron delivery, preferring the live context before falling back to session storage. */
export async function resolveCronCreationDelivery(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  /** Requested job owner and delivery; a configured default destination skips inference. */
  job?: { agentId?: unknown; delivery?: Record<string, unknown> };
  /** Authenticated requester; its human profile is the creator the Gateway stamps. */
  requesterOrigin?: RequesterOrigin;
  currentDeliveryContext?: DeliveryContext;
  agentSessionKey?: string;
}): Promise<CronDelivery | null> {
  // A configured default outranks the creating chat. Pinning the chat route here
  // would make it an explicit per-job route and hide the default, so route-less
  // jobs stay route-less and resolve the current default at run time.
  const jobAgentId = typeof params.job?.agentId === "string" ? params.job.agentId.trim() : "";
  if (
    cronDeliveryUsesDefaultDestination({ delivery: params.job?.delivery }, "announce") &&
    resolveCronDefaultDeliveryDestination({
      cronConfig: params.cfg.cron,
      agentId: jobAgentId || params.agentId,
      creatorProfileId: requesterCreatorProfileId(params.requesterOrigin),
    })
  ) {
    return null;
  }
  // A live internal surface is not missing context: do not pin an older stored
  // external route onto the job. Run-time source routing remains session-owned.
  if (isInternalDeliveryContext(params.currentDeliveryContext)) {
    return null;
  }
  return (
    cronDeliveryFromContext(params.currentDeliveryContext) ??
    cronDeliveryFromContext(
      await resolveCronStoredDeliveryContext({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.agentSessionKey,
      }),
    )
  );
}
