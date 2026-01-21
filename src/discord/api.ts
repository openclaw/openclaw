import { resolveFetch } from "../infra/fetch.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

type DiscordApiErrorPayload = {
  message?: string;
  retry_after?: number;
  code?: number;
  global?: boolean;
};

function parseDiscordApiErrorPayload(text: string): DiscordApiErrorPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const payload = JSON.parse(trimmed);
    if (payload && typeof payload === "object") return payload as DiscordApiErrorPayload;
  } catch {
    return null;
  }
  return null;
}

function formatRetryAfterSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded}s`;
}

function formatDiscordApiErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const payload = parseDiscordApiErrorPayload(trimmed);
  if (!payload) {
    const looksJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    return looksJson ? "unknown error" : trimmed;
  }
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "unknown error";
  const retryAfter = formatRetryAfterSeconds(
    typeof payload.retry_after === "number" ? payload.retry_after : undefined,
  );
  return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}

export async function fetchDiscord<T>(
  path: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = formatDiscordApiErrorText(text);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Discord API ${path} failed (${res.status})${suffix}`);
  }
  return (await res.json()) as T;
}
