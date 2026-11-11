// Records Gateway-executed message-action sends in their destination conversation.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
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
  route: OutboundSessionRoute;
  producerSessionKey?: string;
  agentId?: string;
  payload: ReplyPayload;
  deliveryId: string;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const result = await commitConfirmedVisibleMessage({
      config: params.cfg,
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.route.threadId,
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
    });
    const diagnostic = result.ok ? result.diagnostics : result.reason;
    if (diagnostic) {
      log.warn(`Confirmed gateway action transcript: ${diagnostic}`);
    }
  } catch (error) {
    log.warn(`Confirmed gateway action transcript commit failed: ${formatErrorMessage(error)}`);
  }
}
