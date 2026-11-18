import { normalizeCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { normalizeAccountId } from "../../routing/account-id.js";

/** Map fresh native ingress identity, not message text or stored delivery, to a requester. */
export function resolveReplyCronChannelRequester(params: {
  channel?: string;
  senderId?: string;
  accountId?: string;
  replyAccountId?: string;
}) {
  if (params.channel !== "discord" && params.channel !== "telegram") {
    return undefined;
  }
  return normalizeCronAuthenticatedChannelRequester({
    version: 1,
    channel: params.channel,
    accountId: normalizeAccountId(
      params.channel === "telegram" ? params.accountId : params.replyAccountId,
    ),
    senderId: params.senderId,
  });
}
