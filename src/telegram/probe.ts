import { makeProxyFetch } from "./proxy.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  bot?: {
    id?: number | null;
    username?: string | null;
    canJoinGroups?: boolean | null;
    canReadAllGroupMessages?: boolean | null;
    supportsInlineQueries?: boolean | null;
  };
  webhook?: {
    url?: string | null;
    hasCustomCert?: boolean | null;
    pendingUpdateCount?: number | null;
    lastErrorDate?: number | null;
    lastErrorMessage?: string | null;
  };
};

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTelegram(
  token: string,
  timeoutMs: number,
  proxyUrl?: string,
): Promise<TelegramProbe> {
  const started = Date.now();
  const fetcher = proxyUrl ? makeProxyFetch(proxyUrl) : fetch;
  const base = `${TELEGRAM_API_BASE}/bot${token}`;

  const result: TelegramProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  try {
    const meRes = await fetchWithTimeout(`${base}/getMe`, timeoutMs, fetcher);
    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: {
        id?: number;
        username?: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
        supports_inline_queries?: boolean;
      };
    };
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    result.bot = {
      id: meJson.result?.id ?? null,
      username: meJson.result?.username ?? null,
      canJoinGroups:
        typeof meJson.result?.can_join_groups === "boolean" ? meJson.result?.can_join_groups : null,
      canReadAllGroupMessages:
        typeof meJson.result?.can_read_all_group_messages === "boolean"
          ? meJson.result?.can_read_all_group_messages
          : null,
      supportsInlineQueries:
        typeof meJson.result?.supports_inline_queries === "boolean"
          ? meJson.result?.supports_inline_queries
          : null,
    };

    // Try to fetch webhook info, but don't fail health if it errors.
    try {
      const webhookRes = await fetchWithTimeout(`${base}/getWebhookInfo`, timeoutMs, fetcher);
      const webhookJson = (await webhookRes.json()) as {
        ok?: boolean;
        result?: {
          url?: string;
          has_custom_certificate?: boolean;
          pending_update_count?: number;
          last_error_date?: number;
          last_error_message?: string;
        };
      };
      if (webhookRes.ok && webhookJson?.ok) {
        const wr = webhookJson.result;
        const pendingUpdateCount =
          typeof wr?.pending_update_count === "number" ? wr.pending_update_count : null;
        const lastErrorDate = typeof wr?.last_error_date === "number" ? wr.last_error_date : null;
        const lastErrorMessage =
          typeof wr?.last_error_message === "string" ? wr.last_error_message : null;

        result.webhook = {
          url: wr?.url ?? null,
          hasCustomCert: wr?.has_custom_certificate ?? null,
          pendingUpdateCount,
          lastErrorDate,
          lastErrorMessage,
        };

        // If there is a recent webhook delivery error, mark the probe as degraded.
        // Only relevant when a webhook URL is actively set (not polling mode).
        // "Recent" = error occurred within the last 10 minutes.
        const RECENT_ERROR_THRESHOLD_S = 600;
        const hasActiveWebhook = !!wr?.url;
        if (
          hasActiveWebhook &&
          lastErrorDate != null &&
          Math.floor(Date.now() / 1000) - lastErrorDate < RECENT_ERROR_THRESHOLD_S
        ) {
          result.ok = false;
          result.error = `webhook error: ${lastErrorMessage ?? "unknown"}`;
          result.elapsedMs = Date.now() - started;
          return result;
        }
      }
    } catch {
      // ignore webhook errors for probe
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
