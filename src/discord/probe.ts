import { resolveFetch } from "../infra/fetch.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  bot?: { id?: string | null; username?: string | null };
  application?: DiscordApplicationSummary;
};

export type DiscordPrivilegedIntentStatus = "enabled" | "limited" | "disabled";

export type DiscordPrivilegedIntentsSummary = {
  messageContent: DiscordPrivilegedIntentStatus;
  guildMembers: DiscordPrivilegedIntentStatus;
  presence: DiscordPrivilegedIntentStatus;
};

export type DiscordApplicationSummary = {
  id?: string | null;
  flags?: number | null;
  intents?: DiscordPrivilegedIntentsSummary;
};

const DISCORD_APP_FLAG_GATEWAY_PRESENCE = 1 << 12;
const DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 13;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export function resolveDiscordPrivilegedIntentsFromFlags(
  flags: number,
): DiscordPrivilegedIntentsSummary {
  const resolve = (enabledBit: number, limitedBit: number) => {
    if ((flags & enabledBit) !== 0) return "enabled";
    if ((flags & limitedBit) !== 0) return "limited";
    return "disabled";
  };
  return {
    presence: resolve(DISCORD_APP_FLAG_GATEWAY_PRESENCE, DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED),
    guildMembers: resolve(
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS,
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
    ),
    messageContent: resolve(
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT,
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED,
    ),
  };
}

export async function fetchDiscordApplicationSummary(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<DiscordApplicationSummary | undefined> {
  const normalized = normalizeDiscordToken(token);
  if (!normalized) return undefined;
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/oauth2/applications/@me`,
      timeoutMs,
      fetcher,
      {
        Authorization: `Bot ${normalized}`,
      },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { id?: string; flags?: number };
    const flags =
      typeof json.flags === "number" && Number.isFinite(json.flags) ? json.flags : undefined;
    return {
      id: json.id ?? null,
      flags: flags ?? null,
      intents:
        typeof flags === "number" ? resolveDiscordPrivilegedIntentsFromFlags(flags) : undefined,
    };
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
  headers?: HeadersInit,
): Promise<Response> {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDiscord(
  token: string,
  timeoutMs: number,
  opts?: { fetcher?: typeof fetch; includeApplication?: boolean },
): Promise<DiscordProbe> {
  const started = Date.now();
  const fetcher = opts?.fetcher ?? fetch;
  const includeApplication = opts?.includeApplication === true;
  const normalized = normalizeDiscordToken(token);
  const result: DiscordProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };
  if (!normalized) {
    return {
      ...result,
      error: "missing token",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const res = await fetchWithTimeout(`${DISCORD_API_BASE}/users/@me`, timeoutMs, fetcher, {
      Authorization: `Bot ${normalized}`,
    });
    if (!res.ok) {
      result.status = res.status;
      result.error = `getMe failed (${res.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }
    const json = (await res.json()) as { id?: string; username?: string };
    result.ok = true;
    result.bot = {
      id: json.id ?? null,
      username: json.username ?? null,
    };
    if (includeApplication) {
      result.application =
        (await fetchDiscordApplicationSummary(normalized, timeoutMs, fetcher)) ?? undefined;
    }
    return { ...result, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}

export async function fetchDiscordApplicationId(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const normalized = normalizeDiscordToken(token);
  if (!normalized) return undefined;
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/oauth2/applications/@me`,
      timeoutMs,
      fetcher,
      {
        Authorization: `Bot ${normalized}`,
      },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { id?: string };
    return json.id ?? undefined;
  } catch {
    return undefined;
  }
}
