import type { Client } from "@buape/carbon";
import { loadConfig } from "../../config/config.js";
import { getProtectedDestinationMap, guardWrite } from "../../infra/outbound/write-policy.js";

export async function sendTyping(params: {
  client: Client;
  channelId: string;
  accountId?: string;
}) {
  const cfg = loadConfig();
  if (
    !guardWrite(
      "typing",
      {
        channel: "discord",
        to: params.channelId,
        accountId: params.accountId,
      },
      getProtectedDestinationMap(cfg),
    )
  ) {
    return;
  }
  const channel = await params.client.fetchChannel(params.channelId);
  if (!channel) {
    return;
  }
  if ("triggerTyping" in channel && typeof channel.triggerTyping === "function") {
    await channel.triggerTyping();
  }
}
