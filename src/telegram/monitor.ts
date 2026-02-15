import { type RunOptions, run } from "@grammyjs/runner";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
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
  webhookHost?: string;
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
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Retry transient failures for a limited window before surfacing errors.
      maxRetryTime: 5 * 60 * 1000,
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

/**
 * Health check interval: how often to ping Telegram API to detect stale connections.
 * After inactivity, NAT/firewalls may silently drop TCP connections, causing the
 * long-polling socket to hang indefinitely. This watchdog detects and recovers from that.
 */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const HEALTH_CHECK_TIMEOUT_MS = 10 * 1000; // 10 seconds

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

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;

  // Register handler for Grammy HttpError unhandled rejections.
  // This catches network errors that escape the polling loop's try-catch
  // (e.g., from setMyCommands during bot setup).
  // We gate on isGrammyHttpError to avoid suppressing non-Telegram errors.
  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    if (isGrammyHttpError(err) && isRecoverableTelegramNetworkError(err, { context: "polling" })) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true; // handled - don't crash
    }
    return false;
  });

  try {
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
        host: opts.webhookHost ?? account.config.webhookHost,
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
      let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
      let staleConnectionDetected = false;

      const stopOnAbort = () => {
        if (opts.abortSignal?.aborted) {
          void runner.stop();
        }
      };

      // Health check watchdog: periodically ping Telegram API to detect stale connections.
      // If the connection is dead (NAT timeout, firewall drop), the health check will fail
      // and we'll restart the runner.
      // Uses a self-scheduling loop instead of setInterval to prevent overlapping checks
      // when a health check takes longer than the interval period.
      const startHealthCheck = () => {
        const scheduleNext = () => {
          healthCheckTimer = setTimeout(async () => {
            if (opts.abortSignal?.aborted) {
              return;
            }
            try {
              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(
                  () => reject(new Error("Health check timeout")),
                  HEALTH_CHECK_TIMEOUT_MS,
                );
              });
              try {
                await Promise.race([bot.api.getMe(), timeoutPromise]);
              } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
              }
              logVerbose("[telegram] Health check passed");
            } catch (err) {
              if (opts.abortSignal?.aborted) {
                return;
              }
              // Health check failed - connection is likely stale
              staleConnectionDetected = true;
              (opts.runtime?.error ?? console.error)(
                `[telegram] Health check failed (stale connection detected): ${formatErrorMessage(err)}; restarting polling...`,
              );
              void runner.stop();
              return; // Don't schedule next check; runner restart will create a new watchdog
            }
            scheduleNext();
          }, HEALTH_CHECK_INTERVAL_MS);
        };
        scheduleNext();
      };

      const stopHealthCheck = () => {
        if (healthCheckTimer) {
          clearTimeout(healthCheckTimer);
          healthCheckTimer = undefined;
        }
      };

      opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
      startHealthCheck();

      try {
        // runner.task() returns a promise that resolves when the runner stops
        await runner.task();
        if (staleConnectionDetected) {
          // Runner was stopped due to health check failure; continue to restart
          restartAttempts = 0; // Reset backoff since this is a controlled restart
          continue;
        }
        return;
      } catch (err) {
        if (opts.abortSignal?.aborted) {
          throw err;
        }
        const isConflict = isGetUpdatesConflict(err);
        const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
        if (!isConflict && !isRecoverable) {
          throw err;
        }
        restartAttempts += 1;
        const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
        const reason = isConflict ? "getUpdates conflict" : "network error";
        const errMsg = formatErrorMessage(err);
        (opts.runtime?.error ?? console.error)(
          `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationPrecise(delayMs)}.`,
        );
        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch (sleepErr) {
          if (opts.abortSignal?.aborted) {
            return;
          }
          throw sleepErr;
        }
      } finally {
        stopHealthCheck();
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      }
    }
  } finally {
    unregisterHandler();
  }
}
