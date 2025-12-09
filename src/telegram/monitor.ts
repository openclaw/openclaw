import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTelegramBot } from "./bot.js";
import { makeProxyFetch } from "./proxy.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const token = (opts.token ?? process.env.TELEGRAM_BOT_TOKEN)?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or telegram.botToken is required for Telegram gateway",
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (loadConfig().telegram?.proxy
      ? makeProxyFetch(loadConfig().telegram?.proxy as string)
      : undefined);

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
  });

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      path: opts.webhookPath,
      port: opts.webhookPort,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Long polling
  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) bot.stop();
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  try {
    await bot.start();
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
  }
}
