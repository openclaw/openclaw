// Records Gateway-executed message-action sends in their destination conversation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { projectPluginMessageDeliveryFact } from "../../agents/embedded-agent-message-delivery.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { commitConfirmedVisibleMessage } from "../../sessions/confirmed-visible-message.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundSessionRoute } from "./outbound-session.js";
import { buildOutboundSessionContext } from "./session-context.js";

const log = createSubsystemLogger("outbound/message-action-send");

/**
 * Records a Gateway-executed plugin send in its destination conversation.
 * The channel already accepted the send, so failures are only logged.
 */
export async function recordGatewayActionSend(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  route?: OutboundSessionRoute | null;
  producerSessionKey?: string;
  agentId?: string;
  payload: ReplyPayload;
  deliveryId: string;
  signal?: AbortSignal;
  assertDirectAdapterHandoff?: () => void;
}): Promise<void> {
  try {
    const result = await commitConfirmedVisibleMessage({
      config: params.cfg,
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId ?? params.route?.threadId,
      route: params.route,
      producer: buildOutboundSessionContext({
        cfg: params.cfg,
        sessionKey: params.producerSessionKey,
        agentId: params.agentId,
      }),
      payload: params.payload,
      deliveryId: params.deliveryId,
      payloadIndex: 0,
      signal: params.signal,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });
    const diagnostic = result.ok ? result.diagnostics : result.reason;
    if (diagnostic) {
      log.warn(`Confirmed gateway action transcript: ${diagnostic}`);
    }
  } catch (error) {
    log.warn(`Confirmed gateway action transcript commit failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Records a direct Gateway plugin `send` action (`dispatchChannelMessageAction` branch)
 * in its destination conversation when the delivery is settled and not partial.
 */
export async function recordDirectGatewayMessageActionSend(
  ctx: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    params: Record<string, unknown>;
    accountId?: string | null;
    sessionKey?: string;
    agentId?: string;
    abortSignal?: AbortSignal;
    assertDirectAdapterHandoff?: () => void;
  },
  deliveredPayload: unknown,
  deliveryId: string,
  sourceReplySessionKey?: string,
): Promise<void> {
  const deliveryFact = projectPluginMessageDeliveryFact(deliveredPayload);
  if (deliveryFact && (deliveryFact.status !== "settled" || deliveryFact.partialDelivery)) {
    return;
  }
  const to = normalizeOptionalString(ctx.params.to) ?? normalizeOptionalString(ctx.params.target);
  if (!to) {
    return;
  }
  const rawThreadId = ctx.params.threadId;
  const threadId =
    typeof rawThreadId === "number" ? rawThreadId : normalizeOptionalString(rawThreadId);
  const text =
    normalizeOptionalString(ctx.params.message) ?? normalizeOptionalString(ctx.params.text);
  const mediaUrl =
    normalizeOptionalString(ctx.params.media) ?? normalizeOptionalString(ctx.params.mediaUrl);
  await recordGatewayActionSend({
    cfg: ctx.cfg,
    channel: ctx.channel,
    to,
    accountId: ctx.accountId ?? undefined,
    threadId,
    producerSessionKey: sourceReplySessionKey ?? ctx.sessionKey,
    agentId: ctx.agentId,
    payload: {
      ...(text ? { text } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
    },
    deliveryId,
    signal: ctx.abortSignal,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
  });
}

/** Dispatches a direct plugin message action and records confirmed `send` destination history. */
export async function dispatchDirectGatewayMessageAction(
  actionContext: Parameters<typeof dispatchChannelMessageAction>[0],
  deliveryId: string,
  sourceReplySessionKey?: string,
): Promise<{ handled: true; payload: unknown } | { handled: false }> {
  const handled = await dispatchChannelMessageAction(actionContext);
  if (!handled) {
    return { handled: false };
  }
  const payload = extractToolPayload(handled);
  if (actionContext.action === "send") {
    await recordDirectGatewayMessageActionSend(
      actionContext,
      payload,
      deliveryId,
      sourceReplySessionKey,
    );
  }
  return { handled: true, payload };
}
