import { resolveFetch } from "../infra/fetch.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
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
    if ((flags & enabledBit) !== 0) {
      return "enabled";
    }
    if ((flags & limitedBit) !== 0) {
      return "limited";
    }
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
  if (!normalized) {
    return undefined;
  }
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/oauth2/applications/@me`,
      { headers: { Authorization: `Bot ${normalized}` } },
      timeoutMs,
      getResolvedFetch(fetcher),
    );
    if (!res.ok) {
      return undefined;
    }
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

function getResolvedFetch(fetcher: typeof fetch): typeof fetch {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
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
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/users/@me`,
      { headers: { Authorization: `Bot ${normalized}` } },
      timeoutMs,
      getResolvedFetch(fetcher),
    );
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
  if (!normalized) {
    return undefined;
  }
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/oauth2/applications/@me`,
      { headers: { Authorization: `Bot ${normalized}` } },
      timeoutMs,
      getResolvedFetch(fetcher),
    );
    if (!res.ok) {
      return undefined;
    }
    const json = (await res.json()) as { id?: string };
    return json.id ?? undefined;
  } catch {
    return undefined;
  }
}

export type DiscordApplicationIdProbe = {
  ok: boolean;
  elapsedMs: number;
  status?: number | null;
  error?: string | null;
  /**
   * Extra diagnostic details for network failures (DNS, TLS, proxy, etc).
   * Only included when requested by the caller (typically verbose logging).
   */
  errorDetails?: string | null;
  /**
   * Truncated response body for debugging failures.
   * Never includes auth headers; safe to log.
   */
  body?: string | null;
  id?: string | null;
};

function truncateBodyForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}… (truncated, ${text.length} chars total)`;
}

function formatNetworkErrorDetails(err: unknown): string | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const record = err as Record<string, unknown>;
  const parts: string[] = [];

  const pick = (key: string) => {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${value}`);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${value}`);
    }
  };

  pick("name");
  pick("code");
  pick("errno");
  pick("syscall");
  pick("address");
  pick("port");

  const cause = record.cause;
  if (cause && typeof cause === "object") {
    const c = cause as Record<string, unknown>;
    const cparts: string[] = [];
    const cpick = (key: string) => {
      const value = c[key];
      if (typeof value === "string" && value.trim()) {
        cparts.push(`${key}=${value}`);
      } else if (typeof value === "number" && Number.isFinite(value)) {
        cparts.push(`${key}=${value}`);
      }
    };
    cpick("name");
    cpick("code");
    cpick("errno");
    cpick("syscall");
    cpick("address");
    cpick("port");
    if (cparts.length > 0) {
      parts.push(`cause{${cparts.join(" ")}}`);
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Fetch the Discord application id with debug-friendly metadata.
 *
 * Used during channel startup to explain failures like:
 * - invalid token (401)
 * - blocked network / proxy issues (fetch fails / timeout)
 * - Discord API errors (non-200 with JSON error body)
 */
export async function probeDiscordApplicationId(
  token: string,
  timeoutMs: number,
  opts?: { fetcher?: typeof fetch; includeBody?: boolean; maxBodyChars?: number },
): Promise<DiscordApplicationIdProbe> {
  const started = Date.now();
  const fetcher = opts?.fetcher ?? fetch;
  const includeBody = opts?.includeBody === true;
  const maxBodyChars = opts?.maxBodyChars ?? 2000;
  const normalized = normalizeDiscordToken(token);
  const base: DiscordApplicationIdProbe = {
    ok: false,
    status: null,
    error: null,
    errorDetails: null,
    body: null,
    id: null,
    elapsedMs: 0,
  };

  if (!normalized) {
    return { ...base, error: "missing token", elapsedMs: Date.now() - started };
  }

  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/oauth2/applications/@me`,
      timeoutMs,
      fetcher,
      {
        Authorization: `Bot ${normalized}`,
      },
    );

    if (!res.ok) {
      const text = includeBody ? await res.text().catch(() => "") : "";
      return {
        ...base,
        status: res.status,
        error: `oauth2/applications/@me failed (${res.status})`,
        body: includeBody ? truncateBodyForLog(text, maxBodyChars) : null,
        elapsedMs: Date.now() - started,
      };
    }

    const json = (await res.json()) as { id?: string };
    const id = typeof json.id === "string" && json.id.trim() ? json.id.trim() : null;
    return {
      ok: Boolean(id),
      status: res.status,
      error: id ? null : "missing id in response",
      body: null,
      id,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const details = formatNetworkErrorDetails(err);
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      errorDetails: details,
      elapsedMs: Date.now() - started,
    };
  }
}
