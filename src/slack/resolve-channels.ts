import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";

export type SlackChannelLookup = {
  id: string;
  name: string;
  archived: boolean;
  isPrivate: boolean;
};

export type SlackChannelResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  archived?: boolean;
};

type SlackListResponse = {
  channels?: Array<{
    id?: string;
    name?: string;
    is_archived?: boolean;
    is_private?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
};

type SlackConversationInfoResponse = {
  channel?: {
    id?: string;
    name?: string;
    is_archived?: boolean;
    is_private?: boolean;
  };
};

function parseSlackChannelMention(raw: string): { id?: string; name?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
  if (mention) {
    const id = mention[1]?.toUpperCase();
    const name = mention[2]?.trim();
    return { id, name };
  }
  const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
  if (/^[CG][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  const name = prefixed.replace(/^#/, "").trim();
  return name ? { name } : {};
}

async function listSlackChannels(client: WebClient): Promise<SlackChannelLookup[]> {
  const channels: SlackChannelLookup[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    })) as SlackListResponse;
    for (const channel of res.channels ?? []) {
      const id = channel.id?.trim();
      const name = channel.name?.trim();
      if (!id || !name) {
        continue;
      }
      channels.push({
        id,
        name,
        archived: Boolean(channel.is_archived),
        isPrivate: Boolean(channel.is_private),
      });
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);
  return channels;
}

function resolveByName(
  name: string,
  channels: SlackChannelLookup[],
): SlackChannelLookup | undefined {
  const target = name.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  const matches = channels.filter((channel) => channel.name.toLowerCase() === target);
  if (matches.length === 0) {
    return undefined;
  }
  const active = matches.find((channel) => !channel.archived);
  return active ?? matches[0];
}

/** Resolve a single channel by ID via conversations.info (Tier 3). */
async function lookupChannelById(
  client: WebClient,
  channelId: string,
): Promise<SlackChannelLookup | null> {
  try {
    const res = (await client.conversations.info({
      channel: channelId,
    })) as SlackConversationInfoResponse;
    const channel = res.channel;
    if (!channel?.id || !channel.name) {
      return null;
    }
    return {
      id: channel.id,
      name: channel.name,
      archived: Boolean(channel.is_archived),
      isPrivate: Boolean(channel.is_private),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve channel entries using targeted APIs (conversations.info for IDs)
 * and only falling back to conversations.list for name entries.
 */
async function resolveViaTargetedApis(
  client: WebClient,
  entries: string[],
): Promise<SlackChannelResolution[]> {
  const parsed = entries.map((input) => ({ input, ...parseSlackChannelMention(input) }));
  const idEntries = parsed.filter((entry) => entry.id);
  const nameEntries = parsed.filter((entry) => entry.name && !entry.id);
  const emptyEntries = parsed.filter((entry) => !entry.id && !entry.name);

  const results: SlackChannelResolution[] = [];

  // Resolve IDs via conversations.info (Tier 3).
  for (const entry of idEntries) {
    const lookup = await lookupChannelById(client, entry.id!);
    results.push({
      input: entry.input,
      resolved: true,
      id: entry.id,
      name: lookup?.name ?? entry.name,
      archived: lookup?.archived,
    });
  }

  // Only paginate through the full channel list when there are name entries.
  if (nameEntries.length > 0) {
    const channels = await listSlackChannels(client);
    for (const entry of nameEntries) {
      const match = resolveByName(entry.name!, channels);
      if (match) {
        results.push({
          input: entry.input,
          resolved: true,
          id: match.id,
          name: match.name,
          archived: match.archived,
        });
      } else {
        results.push({ input: entry.input, resolved: false });
      }
    }
  }

  for (const entry of emptyEntries) {
    results.push({ input: entry.input, resolved: false });
  }

  return results;
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
  rateLimitPolicy?: "retry" | "fail-fast";
}): Promise<SlackChannelResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);

  if (params.rateLimitPolicy === "fail-fast") {
    return resolveViaTargetedApis(client, params.entries);
  }

  // Default ("retry" or undefined): always use conversations.list — original behavior.
  const channels = await listSlackChannels(client);
  const results: SlackChannelResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseSlackChannelMention(input);
    if (parsed.id) {
      const match = channels.find((channel) => channel.id === parsed.id);
      results.push({
        input,
        resolved: true,
        id: parsed.id,
        name: match?.name ?? parsed.name,
        archived: match?.archived,
      });
      continue;
    }
    if (parsed.name) {
      const match = resolveByName(parsed.name, channels);
      if (match) {
        results.push({
          input,
          resolved: true,
          id: match.id,
          name: match.name,
          archived: match.archived,
        });
        continue;
      }
    }
    results.push({ input, resolved: false });
  }

  return results;
}
