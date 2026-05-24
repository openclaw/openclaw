import { createHash } from "node:crypto";
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import { parseAgentSessionKey, parseThreadSessionSuffix } from "../routing/session-key.js";
import {
  resolveFailureDestination,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
  type CronDeliveryPlan,
  resolveCronDeliveryPlan,
} from "./delivery-plan.js";
import {
  resolveDeliveryTarget,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronMessageChannel } from "./types.js";

export {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  type CronDeliveryPlan,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
};

const FAILURE_NOTIFICATION_TIMEOUT_MS = 30_000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });
const ROUTED_PEER_SESSION_KINDS = new Set(["direct", "dm", "group", "channel"]);

export type CronAnnounceTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  sessionKey?: string;
};

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

function buildCronAnnounceMirrorIdempotencyKey(params: {
  jobId: string;
  target: SuccessfulDeliveryTarget;
  message: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        params.target.channel,
        params.target.accountId ?? "",
        params.target.to,
        params.target.threadId ?? "",
        params.message,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `cron-announce-mirror:v1:${params.jobId}:${digest}`;
}

function isRoutedPeerSessionKey(sessionKey: string): boolean {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(baseSessionKey ?? sessionKey);
  if (!parsed) {
    return false;
  }

  const parts = parsed.rest.split(":").filter(Boolean);
  const peerKind = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return typeof peerKind === "string" && ROUTED_PEER_SESSION_KINDS.has(peerKind);
}

function resolveCronAnnounceMirrorSessionKey(sessionKey: string | undefined): string | undefined {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Routed peer sessions can be active embedded conversations. Mirror only
  // into custom/main session keys here so cron delivery does not race locks.
  return isRoutedPeerSessionKey(trimmed) ? undefined : trimmed;
}

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
      mirrorSessionKey?: string;
    }
  | { ok: false; error: Error }
> {
  const resolvedTarget = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: params.target.channel as CronMessageChannel | undefined,
    to: params.target.to,
    accountId: params.target.accountId,
    sessionKey: params.target.sessionKey,
  });

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
  const mirrorSessionKey = resolveCronAnnounceMirrorSessionKey(params.target.sessionKey);

  return {
    ok: true,
    resolvedTarget,
    session,
    identity,
    ...(mirrorSessionKey ? { mirrorSessionKey } : {}),
  };
}

async function deliverCronAnnouncePayload(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  delivery: {
    resolvedTarget: SuccessfulDeliveryTarget;
    session: ReturnType<typeof buildOutboundSessionContext>;
    identity: ReturnType<typeof resolveAgentOutboundIdentity>;
    mirrorSessionKey?: string;
  };
  agentId: string;
  jobId: string;
  message: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: params.delivery.resolvedTarget.channel,
    to: params.delivery.resolvedTarget.to,
    accountId: params.delivery.resolvedTarget.accountId,
    threadId: params.delivery.resolvedTarget.threadId,
    payloads: [{ text: params.message }],
    session: params.delivery.session,
    identity: params.delivery.identity,
    bestEffort: false,
    deps: createOutboundSendDeps(params.deps),
    signal: params.abortSignal,
    mirror: params.delivery.mirrorSessionKey
      ? {
          sessionKey: params.delivery.mirrorSessionKey,
          agentId: params.agentId,
          text: params.message,
          idempotencyKey: buildCronAnnounceMirrorIdempotencyKey({
            jobId: params.jobId,
            target: params.delivery.resolvedTarget,
            message: params.message,
          }),
        }
      : undefined,
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
}

export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  message: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  await deliverCronAnnouncePayload({
    deps: params.deps,
    cfg: params.cfg,
    delivery,
    agentId: params.agentId,
    jobId: params.jobId,
    message: params.message,
    abortSignal: params.abortSignal,
  });
}

export async function sendFailureNotificationAnnounce(
  deps: CliDeps,
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
  target: CronAnnounceTarget,
  message: string,
): Promise<void> {
  const delivery = await resolveCronAnnounceDelivery({ cfg, agentId, jobId, target });

  if (!delivery.ok) {
    cronDeliveryLogger.warn(
      { error: delivery.error.message },
      "cron: failed to resolve failure destination target",
    );
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, FAILURE_NOTIFICATION_TIMEOUT_MS);

  try {
    await deliverCronAnnouncePayload({
      deps,
      cfg,
      delivery,
      agentId,
      jobId,
      message,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    cronDeliveryLogger.warn(
      {
        err: formatErrorMessage(err),
        channel: delivery.resolvedTarget.channel,
        to: delivery.resolvedTarget.to,
      },
      "cron: failure destination announce failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
