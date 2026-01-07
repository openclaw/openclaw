import { type RunOptions, run } from "@grammyjs/runner";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTelegramBot } from "./bot.js";
import { makeProxyFetch } from "./proxy.js";
import { resolveTelegramToken } from "./token.js";
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

export function createTelegramRunnerOptions(
  cfg: ClawdbotConfig,
): RunOptions<unknown> {
  return {
    sink: {
      concurrency: cfg.agent?.maxConcurrent ?? 1,
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
      },
    },
  };
}

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const cfg = loadConfig();
  const { token } = resolveTelegramToken(cfg, {
    envToken: opts.token,
  });
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or telegram.botToken/tokenFile is required for Telegram gateway",
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (cfg.telegram?.proxy
      ? makeProxyFetch(cfg.telegram?.proxy as string)
      : undefined);

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
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

  // Use grammyjs/runner for concurrent update processing
  const runner = run(bot, createTelegramRunnerOptions(cfg));

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) {
      void runner.stop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    // runner.task() returns a promise that resolves when the runner stops
    await runner.task();
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
  }
}
