import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type RequesterPrivateMessageResult = {
  status: "sent" | "unavailable" | "failed";
};

/** Only host-owned requester context may choose the recipient of a private send. */
export async function sendRequesterPrivateMessage(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  senderId: string;
  text: string;
  assertActive: () => void;
}): Promise<RequesterPrivateMessageResult> {
  if (!params.channel.trim() || !params.accountId.trim() || !params.senderId.trim()) {
    return { status: "unavailable" };
  }
  try {
    params.assertActive();
    const outbound = await loadChannelOutboundAdapter(params.channel);
    if (!outbound?.sendPrivateText) {
      return { status: "unavailable" };
    }
    params.assertActive();
    const result = await outbound.sendPrivateText({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      text: params.text,
      assertActive: params.assertActive,
    });
    return {
      status: result.outcome !== "not_sent" && result.messageId.trim() ? "sent" : "failed",
    };
  } catch {
    // Provider errors can echo the sensitive payload. Return only a safe outcome;
    // the caller must never put the payload in a shared reply or retry queue.
    return { status: "failed" };
  }
}
