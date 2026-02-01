import { type RunOptions, run } from "@grammyjs/runner";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationMs } from "../infra/format-duration.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Enforce 30-second timeout more strictly
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Reduce retry time to prevent long hangs before our own retry logic takes over
      maxRetryTime: 2 * 60 * 1000, // 2 minutes instead of 5
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const MAX_RESTART_ATTEMPTS = 20; // Prevent infinite retry loops

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

const NETWORK_ERROR_SNIPPETS = [
  "fetch failed",
  "network",
  "timeout",
  "socket",
  "econnreset",
  "econnrefused",
  "undici",
];

const isNetworkRelatedError = (err: unknown) => {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err).toLowerCase();
  if (!message) {
    return false;
  }
  return NETWORK_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
};

const isTimeoutAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const error = err as Error;

  // Check if it's an AbortError
  if (error.name !== "AbortError" && !error.message?.includes("This operation was aborted")) {
    return false;
  }

  // Check if it's likely a timeout (vs intentional abort)
  const message = error.message?.toLowerCase() || "";
  const stack = error.stack?.toLowerCase() || "";

  // Look for timeout-related indicators in the error
  return message.includes("timeout") ||
    stack.includes("timeout") ||
    stack.includes("undici") ||
    stack.includes("getupdates");
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

  let lastUpdateId = await readTelegramUpdateOffset({
    accountId: account.accountId,
  });
  const persistUpdateId = async (updateId: number) => {
    if (lastUpdateId !== null && updateId <= lastUpdateId) {
      return;
    }
    lastUpdateId = updateId;
    try {
      await writeTelegramUpdateOffset({
        accountId: account.accountId,
        updateId,
      });
    } catch (err) {
      (opts.runtime?.error ?? console.error)(
        `telegram: failed to persist update offset: ${String(err)}`,
      );
    }
  };

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
    updateOffset: {
      lastUpdateId,
      onUpdateId: persistUpdateId,
    },
  });

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      accountId: account.accountId,
      config: cfg,
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
  let restartAttempts = 0;

  while (!opts.abortSignal?.aborted) {
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
      return;
    } catch (err) {
      // Check if we're actually being aborted vs. a timeout/network error
      const isActualAbort = opts.abortSignal?.aborted === true;

      if (isActualAbort) {
        // This is a real abort signal, don't retry
        return;
      }

      const isConflict = isGetUpdatesConflict(err);
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      const isNetworkError = isNetworkRelatedError(err);
      const isTimeout = isTimeoutAbortError(err);

      // Treat timeout AbortErrors as recoverable network errors
      const shouldRetry = isConflict || isRecoverable || isNetworkError || isTimeout;

      if (!shouldRetry) {
        throw err;
      }

      restartAttempts += 1;

      // Prevent infinite retry loops
      if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        const errMsg = formatErrorMessage(err);
        (opts.runtime?.error ?? console.error)(
          `Telegram monitor: maximum restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded: ${errMsg}`,
        );
        throw err;
      }

      let reason = "network error";
      if (isConflict) reason = "getUpdates conflict";
      else if (isTimeout) reason = "request timeout";

      const errMsg = formatErrorMessage(err);
      const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
      (opts.runtime?.error ?? console.error)(
        `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationMs(delayMs)} (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}).`,
      );

      // Stop the current runner before retrying
      try {
        await runner.stop();
      } catch {
        // Ignore runner stop errors
      }

      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch (sleepErr) {
        if (opts.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    } finally {
      opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    }
  }
}
