import type { Client } from "@buape/carbon";
import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";

/**
 * Send a typing indicator to a Discord channel. Uses the raw REST API
 * (POST /channels/{id}/typing) to avoid the overhead of fetchChannel().
 * This is critical because typing refreshes run on a 6-second interval and
 * Discord clears the indicator after 10 seconds — any unnecessary latency
 * can cause visible flickering.
 */
export async function sendTyping(params: {
  client?: Client;
  rest?: RequestClient;
  channelId: string;
}) {
  const rest = params.rest ?? params.client?.rest;
  if (!rest) {
    return;
  }
  await rest.post(Routes.channelTyping(params.channelId));
}
