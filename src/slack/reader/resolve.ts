import type { WebClient } from "@slack/web-api";

const MAX_COUNT = 100;
const DEFAULT_COUNT = 20;

export function clampCount(count?: number): number {
  if (count === undefined || count === null) {
    return DEFAULT_COUNT;
  }
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
}

export async function resolveChannelId(client: WebClient, channel: string): Promise<string> {
  const trimmed = channel.trim().replace(/^#/, "");
  // If it looks like a Slack channel ID, use it directly
  if (/^[CG][A-Z0-9]+$/i.test(trimmed)) {
    return trimmed;
  }
  // Otherwise resolve by name
  const res = await client.conversations.list({
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 1000,
  });
  const channels = (res as { channels?: Array<{ id?: string; name?: string }> }).channels ?? [];
  const match = channels.find((ch) => ch.name === trimmed);
  if (match?.id) {
    return match.id;
  }
  // Fall back to using the name as-is (Slack API will return channel_not_found)
  return trimmed;
}

type UserInfoResponse = {
  user?: {
    id?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
};

const userCache = new Map<string, string>();

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  if (!userId) {
    return "Unknown";
  }
  const cached = userCache.get(userId);
  if (cached) {
    return cached;
  }
  try {
    const res = (await client.users.info({ user: userId })) as UserInfoResponse;
    const profile = res.user?.profile;
    const name = profile?.display_name?.trim() || profile?.real_name?.trim() || "Unknown";
    userCache.set(userId, name);
    return name;
  } catch {
    return "Unknown";
  }
}
