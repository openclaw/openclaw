import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type RequesterPrivateMessageResult = {
  status: "sent" | "unsupported" | "unavailable" | "failed";
};

/** Only host-owned requester context may choose the recipient of a private send. */
export async function sendRequesterPrivateMessage(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  senderId: string;
  text: string;
  assertActive: () => void;
}): Promise<RequesterPrivateMessageResult> {
  if (!params.channel.trim() || !params.senderId.trim()) {
    return { status: "unavailable" };
  }
  try {
    params.assertActive();
    const outbound = await loadChannelOutboundAdapter(params.channel);
    params.assertActive();
    if (!outbound) {
      return { status: "unavailable" };
    }
    // Only a registered adapter can establish that private delivery is unsupported.
    // Missing registration or failed delivery must never authorize a public link.
    if (!outbound.sendPrivateText) {
      return { status: "unsupported" };
    }
    const accountId = params.accountId?.trim();
    if (!accountId) {
      return { status: "unavailable" };
    }
    const result = await outbound.sendPrivateText({
      cfg: params.cfg,
      accountId,
      senderId: params.senderId,
      text: params.text,
      assertActive: params.assertActive,
    });
    return {
      status: result.outcome !== "not_sent" && result.messageId.trim() ? "sent" : "failed",
    };
  } catch {
    // Provider errors can echo the sensitive payload. A failed private send must
    // not expose that error or trigger a public fallback or recovery queue.
    return { status: "failed" };
  }
}
