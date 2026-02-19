import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";

export type DiscordWebhookAuth = {
  id: string;
  token: string;
};

const channelWebhookCache = new Map<string, DiscordWebhookAuth>();

/** Set of webhook IDs created by this gateway — used to detect self-webhook messages. */
const ownWebhookIds = new Set<string>();

/** Check if a webhook ID belongs to this gateway. */
export function isOwnWebhookId(webhookId: string): boolean {
  return ownWebhookIds.has(webhookId);
}

function normalizeWebhookAuth(raw: {
  id?: string;
  token?: string | null;
}): DiscordWebhookAuth | null {
  const id = raw.id?.trim();
  const token = raw.token?.trim();
  if (!id || !token) {
    return null;
  }
  return { id, token };
}

export async function getOrCreateWebhook(
  channelId: string,
  rest: RequestClient,
): Promise<DiscordWebhookAuth | null> {
  const cached = channelWebhookCache.get(channelId);
  if (cached) {
    return cached;
  }

  try {
    const created = (await rest.post(Routes.channelWebhooks(channelId), {
      body: {
        name: "OpenClaw Agent",
      },
    })) as { id?: string; token?: string | null };
    const normalized = normalizeWebhookAuth(created);
    if (!normalized) {
      return null;
    }
    channelWebhookCache.set(channelId, normalized);
    ownWebhookIds.add(normalized.id);
    return normalized;
  } catch {
    return null;
  }
}
