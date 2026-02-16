import { Bot } from "@maxhub/max-bot-api";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../plugins/runtime/types.js";
import { makeProxyFetch } from "../telegram/proxy.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

const MAX_API_BASE = "https://platform-api.max.ru";

/** Options for monitoring a MAX bot provider. */
export type MonitorMaxOpts = {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  proxy?: string;
};

/** Restart backoff policy for polling failures. */
const MAX_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

/** Compute exponential backoff with jitter. */
function computeBackoff(attempt: number): number {
  const { initialMs, maxMs, factor, jitter } = MAX_POLL_RESTART_POLICY;
  const base = Math.min(initialMs * factor ** attempt, maxMs);
  const jitterRange = base * jitter;
  return base + (Math.random() * 2 - 1) * jitterRange;
}

/**
 * Monitor a MAX bot using long polling or webhook mode.
 *
 * In long-polling mode, uses the @maxhub/max-bot-api Bot class.
 * In webhook mode, subscribes via POST /subscriptions and starts an HTTP server.
 *
 * Returns a promise that resolves when monitoring stops (via abortSignal).
 */
export async function monitorMaxProvider(opts: MonitorMaxOpts): Promise<void> {
  if (opts.useWebhook && opts.webhookUrl) {
    return monitorMaxWebhook(opts);
  }
  return monitorMaxPolling(opts);
}

// ---------------------------------------------------------------------------
// Long Polling
// ---------------------------------------------------------------------------

async function monitorMaxPolling(opts: MonitorMaxOpts): Promise<void> {
  const { token, abortSignal } = opts;
  let attempt = 0;

  while (!abortSignal?.aborted) {
    try {
      const bot = new Bot(token);

      // Register a generic update handler that delegates to the runtime
      bot.use(async (ctx) => {
        // The runtime will handle message processing via the gateway pipeline.
        // This is where the channel's inbound processing hook would be invoked.
        opts.runtime?.log?.(
          `[max:${opts.accountId ?? "default"}] received update: ${ctx.updateType}`,
        );
      });

      // Start polling (blocks until stopped or error)
      const startPromise = bot.start({
        allowedUpdates: [
          "message_created",
          "message_callback",
          "message_edited",
          "message_removed",
          "bot_started",
          "bot_added",
          "bot_removed",
          "user_added",
          "user_removed",
        ],
      });

      // Wire abort signal to stop the bot
      if (abortSignal) {
        const stopOnAbort = () => {
          bot.stop();
        };
        abortSignal.addEventListener("abort", stopOnAbort, { once: true });
      }

      await startPromise;
      attempt = 0; // Reset on clean exit
    } catch (err) {
      if (abortSignal?.aborted) {
        break;
      }
      const backoff = computeBackoff(attempt);
      opts.runtime?.log?.(
        `[max:${opts.accountId ?? "default"}] polling error (attempt ${attempt + 1}), ` +
          `retrying in ${Math.round(backoff)}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function monitorMaxWebhook(opts: MonitorMaxOpts): Promise<void> {
  const { token, webhookUrl, webhookSecret, abortSignal } = opts;
  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
  };
  const fetcher = opts.proxy ? makeProxyFetch(opts.proxy) : fetch;

  // Step 1: Subscribe webhook via POST /subscriptions
  const subBody: Record<string, unknown> = {
    url: webhookUrl,
    update_types: [
      "message_created",
      "message_callback",
      "message_edited",
      "message_removed",
      "bot_started",
      "bot_added",
      "bot_removed",
    ],
  };

  if (webhookSecret) {
    subBody.secret = webhookSecret;
  }

  const subRes = await fetchWithTimeout(
    `${MAX_API_BASE}/subscriptions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(subBody),
    },
    15_000,
    fetcher,
  );

  if (!subRes.ok) {
    const errorBody = await subRes.text().catch(() => "");
    throw new Error(`MAX webhook subscription failed (${subRes.status}): ${errorBody}`);
  }

  opts.runtime?.log?.(`[max:${opts.accountId ?? "default"}] webhook subscribed at ${webhookUrl}`);

  // Step 2: Keep alive until abort signal fires
  // The actual HTTP server for receiving webhooks is managed by the gateway
  // framework (shared webhook receiver). This function just manages the
  // subscription lifecycle.
  if (abortSignal) {
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  // Step 3: Unsubscribe on shutdown
  try {
    await fetchWithTimeout(
      `${MAX_API_BASE}/subscriptions`,
      { method: "DELETE", headers },
      10_000,
      fetcher,
    );
    opts.runtime?.log?.(`[max:${opts.accountId ?? "default"}] webhook unsubscribed`);
  } catch {
    // Best-effort cleanup
  }
}
