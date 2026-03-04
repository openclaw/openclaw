import { type RunOptions, run } from "@grammyjs/runner";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
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
      // Keep grammY retrying for a long outage window. If polling still
      // stops, the outer monitor loop restarts it with backoff.
      maxRetryTime: 60 * 60 * 1000,
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

type TelegramBot = ReturnType<typeof createTelegramBot>;

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
  let activeRunner: ReturnType<typeof run> | undefined;
  let forceRestarted = false;

  // Register handler for Grammy HttpError unhandled rejections.
  // This catches network errors that escape the polling loop's try-catch
  // (e.g., from setMyCommands during bot setup).
  // We gate on isGrammyHttpError to avoid suppressing non-Telegram errors.
  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
    if (isGrammyHttpError(err) && isNetworkError) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true; // handled - don't crash
    }
    // Network failures can surface outside the runner task promise and leave
    // polling stuck; force-stop the active runner so the loop can recover.
    if (isNetworkError && activeRunner && activeRunner.isRunning()) {
      forceRestarted = true;
      void activeRunner.stop().catch(() => {});
      log(
        `[telegram] Restarting polling after unhandled network error: ${formatErrorMessage(err)}`,
      );
      return true; // handled
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
      botToken: token,
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
          botToken: token,
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`,
        );
      }
    };

    if (opts.useWebhook) {
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret ?? account.config.webhookSecret,
        host: opts.webhookHost ?? account.config.webhookHost,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
      });
      await waitForAbortSignal(opts.abortSignal);
      return;
    }

    // Use grammyjs/runner for concurrent update processing
    let restartAttempts = 0;
    let webhookCleared = false;
    const runnerOptions = createTelegramRunnerOptions(cfg);
    const waitBeforeRestart = async (buildLine: (delay: string) => string): Promise<boolean> => {
      restartAttempts += 1;
      const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
      const delay = formatDurationPrecise(delayMs);
      log(buildLine(delay));
      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch (sleepErr) {
        if (opts.abortSignal?.aborted) {
          return false;
        }
        throw sleepErr;
      }
      return true;
    };

    const waitBeforeRetryOnRecoverableSetupError = async (
      err: unknown,
      logPrefix: string,
    ): Promise<boolean> => {
      if (opts.abortSignal?.aborted) {
        return false;
      }
      if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
        throw err;
      }
      return waitBeforeRestart(
        (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
      );
    };

    const createPollingBot = async (): Promise<TelegramBot | undefined> => {
      try {
        return createTelegramBot({
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
      } catch (err) {
        const shouldRetry = await waitBeforeRetryOnRecoverableSetupError(
          err,
          "Telegram setup network error",
        );
        if (!shouldRetry) {
          return undefined;
        }
        return undefined;
      }
    };

    const ensureWebhookCleanup = async (bot: TelegramBot): Promise<"ready" | "retry" | "exit"> => {
      if (webhookCleared) {
        return "ready";
      }
      try {
        await withTelegramApiErrorLogging({
          operation: "deleteWebhook",
          runtime: opts.runtime,
          fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
        });
        webhookCleared = true;
        return "ready";
      } catch (err) {
        const shouldRetry = await waitBeforeRetryOnRecoverableSetupError(
          err,
          "Telegram webhook cleanup failed",
        );
        return shouldRetry ? "retry" : "exit";
      }
    };

    const runPollingCycle = async (bot: TelegramBot): Promise<"continue" | "exit"> => {
      const runner = run(bot, runnerOptions);
      activeRunner = runner;
      let stopPromise: Promise<void> | undefined;
      let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
      let staleConnectionDetected = false;
      const stopRunner = () => {
        stopPromise ??= Promise.resolve(runner.stop())
          .then(() => undefined)
          .catch(() => {
            // Runner may already be stopped by abort/retry paths.
          });
        return stopPromise;
      };
      const stopBot = () => {
        return Promise.resolve(bot.stop())
          .then(() => undefined)
          .catch(() => {
            // Bot may already be stopped by runner stop/abort paths.
          });
      };
      const stopOnAbort = () => {
        if (opts.abortSignal?.aborted) {
          void stopRunner();
        }
      };

      // Health check watchdog: periodically ping Telegram API to detect stale connections.
      // If the connection is dead (NAT timeout, firewall drop), the health check will fail
      // and we'll restart the runner.
      // Uses a self-scheduling loop instead of setInterval to prevent overlapping checks
      // when a health check takes longer than the interval period.
      // healthCheckStopped guards against a concurrent in-flight check scheduling a new
      // timer after stopHealthCheck() has been called (e.g., during runner teardown).
      let healthCheckStopped = false;
      const startHealthCheck = () => {
        const scheduleNext = () => {
          healthCheckTimer = setTimeout(async () => {
            if (healthCheckStopped || opts.abortSignal?.aborted) {
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
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                }
              }
              logVerbose("[telegram] Health check passed");
            } catch (err) {
              if (healthCheckStopped || opts.abortSignal?.aborted) {
                return;
              }
              // Health check failed - connection is likely stale
              staleConnectionDetected = true;
              (opts.runtime?.error ?? console.error)(
                `[telegram] Health check failed (stale connection detected): ${formatErrorMessage(err)}; restarting polling...`,
              );
              void stopRunner();
              return; // Don't schedule next check; runner restart will create a new watchdog
            }
            // Only reschedule if watchdog is still active (not torn down mid-check).
            if (!healthCheckStopped) {
              scheduleNext();
            }
          }, HEALTH_CHECK_INTERVAL_MS);
        };
        scheduleNext();
      };

      const stopHealthCheck = () => {
        healthCheckStopped = true;
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
        // Abort takes highest priority — always exit cleanly when signaled.
        if (opts.abortSignal?.aborted) {
          return "exit";
        }
        if (staleConnectionDetected) {
          // Runner was stopped due to health check failure; continue to restart
          // without backoff since this is a controlled recovery restart.
          forceRestarted = false;
          restartAttempts = 0;
          return "continue";
        }
        const reason = forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
        forceRestarted = false;
        const shouldRestart = await waitBeforeRestart(
          (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
        );
        return shouldRestart ? "continue" : "exit";
      } catch (err) {
        forceRestarted = false;
        if (opts.abortSignal?.aborted) {
          throw err;
        }
        const isConflict = isGetUpdatesConflict(err);
        const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
        if (!isConflict && !isRecoverable) {
          throw err;
        }
        const reason = isConflict ? "getUpdates conflict" : "network error";
        const errMsg = formatErrorMessage(err);
        const shouldRestart = await waitBeforeRestart(
          (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
        );
        return shouldRestart ? "continue" : "exit";
      } finally {
        stopHealthCheck();
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
        await stopRunner();
        await stopBot();
      }
    };

    while (!opts.abortSignal?.aborted) {
      const bot = await createPollingBot();
      if (!bot) {
        continue;
      }

      const cleanupState = await ensureWebhookCleanup(bot);
      if (cleanupState === "retry") {
        continue;
      }
      if (cleanupState === "exit") {
        return;
      }

      const state = await runPollingCycle(bot);
      if (state === "exit") {
        return;
      }
    }
  } finally {
    unregisterHandler();
  }
}
