import { resolveFetch } from "../infra/fetch.js";

const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";
const PLURALKIT_LOOKUP_TIMEOUT_MS = 1_500;

export type DiscordPluralKitConfig = {
  enabled?: boolean;
  token?: string;
};

export type PluralKitSystemInfo = {
  id: string;
  name?: string | null;
  tag?: string | null;
};

export type PluralKitMemberInfo = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

export type PluralKitMessageInfo = {
  id: string;
  original?: string | null;
  sender?: string | null;
  system?: PluralKitSystemInfo | null;
  member?: PluralKitMemberInfo | null;
};

export async function fetchPluralKitMessageInfo(params: {
  messageId: string;
  config?: DiscordPluralKitConfig;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<PluralKitMessageInfo | null> {
  if (!params.config?.enabled) {
    return null;
  }
  const fetchImpl = resolveFetch(params.fetcher);
  if (!fetchImpl) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (params.config.token?.trim()) {
    headers.Authorization = params.config.token.trim();
  }
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.trunc(params.timeoutMs))
      : PLURALKIT_LOOKUP_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const controller =
    timeoutMs > 0 && typeof AbortController !== "undefined" ? new AbortController() : undefined;
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timeoutId.unref?.();
  }
  let res: Response;
  try {
    res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, {
      headers,
      signal: controller?.signal,
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text.trim() ? `: ${text.trim()}` : "";
    throw new Error(`PluralKit API failed (${res.status})${detail}`);
  }
  return (await res.json()) as PluralKitMessageInfo;
}
