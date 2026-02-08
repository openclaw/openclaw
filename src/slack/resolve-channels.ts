import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";

/** Matches Slack channel_id required by files.uploadV2: C/G/D/Z prefix + 8+ alphanumeric. */
const SLACK_CHANNEL_ID_REGEX = /^[CGDZ][A-Z0-9]{8,}$/i;

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
  if (SLACK_CHANNEL_ID_REGEX.test(prefixed)) {
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

/**
 * Resolves a channel identifier (ID or name) to a valid channel_id for files.uploadV2.
 * Accepts: raw ID (C/G/D/Z + 8+ chars), "#name", "name", "channel:<id>", "<#id|name>".
 * Uses conversations.list to resolve by name; bot must be a member of private channels.
 */
export async function resolveChannelIdForUpload(
  client: WebClient,
  channelIdOrName: string,
): Promise<string> {
  const input = channelIdOrName.trim();
  if (!input) {
    throw new Error("Slack channel identifier is required");
  }

  if (SLACK_CHANNEL_ID_REGEX.test(input)) {
    return input.toUpperCase();
  }

  const parsed = parseSlackChannelMention(input);

  const idCandidate = (parsed.id ?? "").trim();
  if (idCandidate && SLACK_CHANNEL_ID_REGEX.test(idCandidate)) {
    return idCandidate.toUpperCase();
  }

  const nameCandidateRaw = (parsed.name ?? "").trim() || input.replace(/^#/, "").trim();
  const nameToResolve = nameCandidateRaw.toLowerCase();
  if (!nameToResolve) {
    throw new Error(
      `Invalid Slack channel identifier: "${input}" (use #channel-name, <#C...|name>, or channel:<id>)`,
    );
  }

  const channels = await listSlackChannels(client);
  const match = resolveByName(nameToResolve, channels);
  if (match) {
    return match.id;
  }

  throw new Error(
    `Slack channel not found or bot not a member: "${nameToResolve}" (use channel:<id> or ensure bot is in #${nameToResolve})`,
  );
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);
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
