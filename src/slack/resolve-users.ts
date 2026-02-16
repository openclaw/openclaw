import type { WebClient } from "@slack/web-api";
import { createSlackWebClient, createSlackWebClientBulk } from "./client.js";

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

type SlackUserInfoMember = {
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

function memberToLookup(member: SlackUserInfoMember): SlackUserLookup | null {
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
}

/** Resolve a single user by ID via users.info (Tier 4 — generous rate limit). */
async function lookupUserById(client: WebClient, userId: string): Promise<SlackUserLookup | null> {
  try {
    const res = (await client.users.info({ user: userId })) as { user?: SlackUserInfoMember };
    if (!res.user) {
      return null;
    }
    return memberToLookup(res.user);
  } catch {
    return null;
  }
}

/** Resolve a single user by email via users.lookupByEmail (Tier 3). */
async function lookupUserByEmail(
  client: WebClient,
  email: string,
): Promise<SlackUserLookup | null> {
  try {
    const res = (await client.users.lookupByEmail({ email })) as { user?: SlackUserInfoMember };
    if (!res.user) {
      return null;
    }
    return memberToLookup(res.user);
  } catch {
    return null;
  }
}

/**
 * Paginate through all workspace users via users.list (Tier 2 — strict rate limit).
 * Only used when entries contain display names that require fuzzy matching.
 */
async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  const users: SlackUserLookup[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.users.list({
      limit: 200,
      cursor,
    })) as SlackListUsersResponse;
    for (const member of res.members ?? []) {
      const lookup = memberToLookup(member);
      if (lookup) {
        users.push(lookup);
      }
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

function buildResolutionFromLookup(
  input: string,
  id: string,
  lookup: SlackUserLookup | null,
): SlackUserResolution {
  return {
    input,
    resolved: true,
    id,
    name: lookup ? (lookup.displayName ?? lookup.realName ?? lookup.name) : undefined,
    email: lookup?.email,
    deleted: lookup?.deleted,
    isBot: lookup?.isBot,
  };
}

/**
 * Resolve allowlist entries using targeted APIs (users.info for IDs, users.lookupByEmail
 * for emails) and only falling back to users.list for name entries.
 */
async function resolveViaTargetedApis(
  client: WebClient,
  entries: string[],
): Promise<SlackUserResolution[]> {
  const parsed = entries.map((input) => ({ input, ...parseSlackUserInput(input) }));
  const idEntries = parsed.filter((entry) => entry.id);
  const emailEntries = parsed.filter((entry) => entry.email);
  const nameEntries = parsed.filter((entry) => entry.name);
  const emptyEntries = parsed.filter((entry) => !entry.id && !entry.email && !entry.name);

  const results: SlackUserResolution[] = [];

  // Resolve IDs via users.info (Tier 4 — ~100+ req/min).
  for (const entry of idEntries) {
    const lookup = await lookupUserById(client, entry.id!);
    results.push(buildResolutionFromLookup(entry.input, entry.id!, lookup));
  }

  // Resolve emails via users.lookupByEmail (Tier 3).
  for (const entry of emailEntries) {
    const lookup = await lookupUserByEmail(client, entry.email!);
    if (lookup) {
      results.push(buildResolutionFromLookup(entry.input, lookup.id, lookup));
    } else {
      results.push({ input: entry.input, resolved: false });
    }
  }

  // Only paginate through the full user list when there are name entries
  // that require fuzzy matching — this is the expensive Tier 2 call.
  if (nameEntries.length > 0) {
    const users = await listSlackUsers(client);
    for (const entry of nameEntries) {
      const target = entry.name!.toLowerCase();
      const matches = users.filter((user) => {
        const candidates = [user.name, user.displayName, user.realName]
          .map((value) => value?.toLowerCase())
          .filter(Boolean) as string[];
        return candidates.includes(target);
      });
      if (matches.length > 0) {
        results.push(resolveSlackUserFromMatches(entry.input, matches, { name: entry.name }));
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

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
  rateLimitPolicy?: "retry" | "fail-fast";
}): Promise<SlackUserResolution[]> {
  const client =
    params.client ??
    (params.rateLimitPolicy === "fail-fast"
      ? createSlackWebClientBulk(params.token)
      : createSlackWebClient(params.token));

  if (params.rateLimitPolicy === "fail-fast") {
    return resolveViaTargetedApis(client, params.entries);
  }

  // Default ("retry" or undefined): always use users.list — original behavior.
  const users = await listSlackUsers(client);
  const results: SlackUserResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseSlackUserInput(input);
    if (parsed.id) {
      const match = users.find((user) => user.id === parsed.id);
      results.push({
        input,
        resolved: true,
        id: parsed.id,
        name: match?.displayName ?? match?.realName ?? match?.name,
        email: match?.email,
        deleted: match?.deleted,
        isBot: match?.isBot,
      });
      continue;
    }
    if (parsed.email) {
      const matches = users.filter((user) => user.email === parsed.email);
      if (matches.length > 0) {
        results.push(resolveSlackUserFromMatches(input, matches, parsed));
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
        results.push(resolveSlackUserFromMatches(input, matches, parsed));
        continue;
      }
    }

    results.push({ input, resolved: false });
  }

  return results;
}
