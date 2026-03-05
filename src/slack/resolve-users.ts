import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";

export type SlackUserLookup = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
};

export type SlackUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  note?: string;
};

type SlackListUsersResponse = {
  members?: Array<{
    id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  }>;
  response_metadata?: { next_cursor?: string };
};

function parseSlackUserInput(raw: string): { id?: string; name?: string; email?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) {
    return { id: mention[1]?.toUpperCase() };
  }
  const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
  if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  if (trimmed.includes("@") && !trimmed.startsWith("@")) {
    return { email: trimmed.toLowerCase() };
  }
  const name = trimmed.replace(/^@/, "").trim();
  return name ? { name } : {};
}

async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  const users: SlackUserLookup[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.users.list({
      limit: 200,
      cursor,
    })) as SlackListUsersResponse;
    for (const member of res.members ?? []) {
      const id = member.id?.trim();
      const name = member.name?.trim();
      if (!id || !name) {
        continue;
      }
      const profile = member.profile ?? {};
      users.push({
        id,
        name,
        displayName: profile.display_name?.trim() || undefined,
        realName: profile.real_name?.trim() || member.real_name?.trim() || undefined,
        email: profile.email?.trim()?.toLowerCase() || undefined,
        deleted: Boolean(member.deleted),
        isBot: Boolean(member.is_bot),
        isAppUser: Boolean(member.is_app_user),
      });
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);
  return users;
}

function scoreSlackUser(user: SlackUserLookup, match: { name?: string; email?: string }): number {
  let score = 0;
  if (!user.deleted) {
    score += 3;
  }
  if (!user.isBot && !user.isAppUser) {
    score += 2;
  }
  if (match.email && user.email === match.email) {
    score += 5;
  }
  if (match.name) {
    const target = match.name.toLowerCase();
    const candidates = [user.name, user.displayName, user.realName]
      .map((value) => value?.toLowerCase())
      .filter(Boolean) as string[];
    if (candidates.some((value) => value === target)) {
      score += 2;
    }
  }
  return score;
}

function resolveSlackUserFromMatches(
  input: string,
  matches: SlackUserLookup[],
  parsed: { name?: string; email?: string },
): SlackUserResolution {
  const scored = matches
    .map((user) => ({ user, score: scoreSlackUser(user, parsed) }))
    .toSorted((a, b) => b.score - a.score);
  const best = scored[0]?.user ?? matches[0];
  return {
    input,
    resolved: true,
    id: best.id,
    name: best.displayName ?? best.realName ?? best.name,
    email: best.email,
    deleted: best.deleted,
    isBot: best.isBot,
    note: matches.length > 1 ? "multiple matches; chose best" : undefined,
  };
}

type SlackUserInfoResponse = {
  ok?: boolean;
  user?: {
    id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  };
};

async function lookupSlackUserById(
  client: WebClient,
  userId: string,
): Promise<SlackUserLookup | null> {
  try {
    const res = (await client.users.info({ user: userId })) as SlackUserInfoResponse;
    const member = res.user;
    if (!member) {
      return null;
    }
    const id = member.id?.trim();
    const name = member.name?.trim();
    if (!id || !name) {
      return null;
    }
    const profile = member.profile ?? {};
    return {
      id,
      name,
      displayName: profile.display_name?.trim() || undefined,
      realName: profile.real_name?.trim() || member.real_name?.trim() || undefined,
      email: profile.email?.trim()?.toLowerCase() || undefined,
      deleted: Boolean(member.deleted),
      isBot: Boolean(member.is_bot),
      isAppUser: Boolean(member.is_app_user),
    };
  } catch {
    return null;
  }
}

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);
  const results: SlackUserResolution[] = [];

  const idEntries: Array<{ index: number; input: string; id: string }> = [];
  const otherEntries: Array<{
    index: number;
    input: string;
    parsed: ReturnType<typeof parseSlackUserInput>;
  }> = [];

  for (let i = 0; i < params.entries.length; i++) {
    const input = params.entries[i];
    const parsed = parseSlackUserInput(input);
    if (parsed.id) {
      idEntries.push({ index: i, input, id: parsed.id });
    } else {
      otherEntries.push({ index: i, input, parsed });
    }
  }

  const ordered: Array<{ index: number; result: SlackUserResolution }> = [];

  const idLookupCache = new Map<string, SlackUserLookup | null>();
  for (const { index, input, id } of idEntries) {
    let match = idLookupCache.get(id);
    if (match === undefined) {
      match = await lookupSlackUserById(client, id);
      idLookupCache.set(id, match);
    }
    ordered.push({
      index,
      result: {
        input,
        resolved: true,
        id,
        name: match?.displayName ?? match?.realName ?? match?.name,
        email: match?.email,
        deleted: match?.deleted,
        isBot: match?.isBot,
      },
    });
  }

  if (otherEntries.length > 0) {
    const users = await listSlackUsers(client);
    for (const { index, input, parsed } of otherEntries) {
      if (parsed.email) {
        const matches = users.filter((user) => user.email === parsed.email);
        if (matches.length > 0) {
          ordered.push({ index, result: resolveSlackUserFromMatches(input, matches, parsed) });
          continue;
        }
      }
      if (parsed.name) {
        const target = parsed.name.toLowerCase();
        const matches = users.filter((user) => {
          const candidates = [user.name, user.displayName, user.realName]
            .map((value) => value?.toLowerCase())
            .filter(Boolean) as string[];
          return candidates.includes(target);
        });
        if (matches.length > 0) {
          ordered.push({ index, result: resolveSlackUserFromMatches(input, matches, parsed) });
          continue;
        }
      }
      ordered.push({ index, result: { input, resolved: false } });
    }
  }

  ordered.sort((a, b) => a.index - b.index);
  for (const { result } of ordered) {
    results.push(result);
  }

  return results;
}
