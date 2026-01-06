import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  bot?: { id?: string | null; username?: string | null };
};

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
  headers?: HeadersInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDiscord(
  token: string,
  timeoutMs: number,
): Promise<DiscordProbe> {
  const started = Date.now();
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
      timeoutMs,
      fetch,
      {
        Authorization: `Bot ${normalized}`,
      },
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
