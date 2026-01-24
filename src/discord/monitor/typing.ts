import type { Client } from "@buape/carbon";

export async function sendTyping(params: { client: Client; channelId: string }) {
  const channel = await params.client.fetchChannel(params.channelId);
  if (!channel) return;
  if ("triggerTyping" in channel && typeof channel.triggerTyping === "function") {
    await channel.triggerTyping();
  }
}
