import { type RunOptions, run } from "@grammyjs/runner";
import { logVerbose } from "../globals.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Health check interval: how often to ping Telegram API to detect stale connections.
 * After inactivity, NAT/firewalls may silently drop TCP connections, causing the
 * long-polling socket to hang indefinitely. This watchdog detects and recovers from that.
 */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const HEALTH_CHECK_TIMEOUT_MS = 10 * 1000; // 10 seconds

type TelegramBot = ReturnType<typeof createTelegramBot>;

type TelegramPollingSessionOpts = {
  token: string;
  config: Parameters<typeof createTelegramBot>[0]["config"];
  accountId: string;
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  abortSignal?: AbortSignal;
  runnerOptions: RunOptions<unknown>;
  getLastUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => Promise<void>;
  log: (line: string) => void;
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;

  constructor(private readonly opts: TelegramPollingSessionOpts) {}

  get activeRunner() {
    return this.#activeRunner;
  }

  markForceRestarted() {
    this.#forceRestarted = true;
  }

  abortActiveFetch() {
    this.#activeFetchAbort?.abort();
  }

  async runUntilAbort(): Promise<void> {
    while (!this.opts.abortSignal?.aborted) {
      const bot = await this.#createPollingBot();
      if (!bot) {
        continue;
      }

      const cleanupState = await this.#ensureWebhookCleanup(bot);
      if (cleanupState === "retry") {
        continue;
      }
      if (cleanupState === "exit") {
        return;
      }

      const state = await this.#runPollingCycle(bot);
      if (state === "exit") {
        return;
      }
    }
  }

  async #waitBeforeRestart(buildLine: (delay: string) => string): Promise<boolean> {
    this.#restartAttempts += 1;
    const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
    const delay = formatDurationPrecise(delayMs);
    this.opts.log(buildLine(delay));
    try {
      await sleepWithAbort(delayMs, this.opts.abortSignal);
    } catch (sleepErr) {
      if (this.opts.abortSignal?.aborted) {
        return false;
      }
      throw sleepErr;
    }
    return true;
  }

  async #waitBeforeRetryOnRecoverableSetupError(err: unknown, logPrefix: string): Promise<boolean> {
    if (this.opts.abortSignal?.aborted) {
      return false;
    }
    if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
      throw err;
    }
    return this.#waitBeforeRestart(
      (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
    );
  }

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const fetchAbortController = new AbortController();
    this.#activeFetchAbort = fetchAbortController;
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        proxyFetch: this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        fetchAbortSignal: fetchAbortController.signal,
        updateOffset: {
          lastUpdateId: this.opts.getLastUpdateId(),
          onUpdateId: this.opts.persistUpdateId,
        },
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
      return undefined;
    }
  }

  async #ensureWebhookCleanup(bot: TelegramBot): Promise<"ready" | "retry" | "exit"> {
    if (this.#webhookCleared) {
      return "ready";
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "deleteWebhook",
        runtime: this.opts.runtime,
        fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
      });
      this.#webhookCleared = true;
      return "ready";
    } catch (err) {
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram webhook cleanup failed",
      );
      return shouldRetry ? "retry" : "exit";
    }
  }

  async #confirmPersistedOffset(bot: TelegramBot): Promise<void> {
    const lastUpdateId = this.opts.getLastUpdateId();
    if (lastUpdateId === null || lastUpdateId >= Number.MAX_SAFE_INTEGER) {
      return;
    }
    try {
      await bot.api.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
    } catch {
      // Non-fatal: runner middleware still skips duplicates via shouldSkipUpdate.
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    await this.#confirmPersistedOffset(bot);

    let lastGetUpdatesAt = Date.now();
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getUpdates") {
        lastGetUpdatesAt = Date.now();
      }
      return prev(method, payload, signal);
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let staleConnectionDetected = false;
    const stopRunner = () => {
      fetchAbortController?.abort();
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
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
        return;
      }
      const elapsed = Date.now() - lastGetUpdatesAt;
      if (elapsed > POLL_STALL_THRESHOLD_MS && runner.isRunning()) {
        stalledRestart = true;
        this.opts.log(
          `[telegram] Polling stall detected (no getUpdates for ${formatDurationPrecise(elapsed)}); forcing restart.`,
        );
        void stopRunner();
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    // Health check watchdog: periodically ping Telegram API to detect stale connections.
    // If the connection is dead (NAT timeout, firewall drop), the health check will fail
    // and we'll restart the runner.
    // Uses a self-scheduling loop instead of setInterval to prevent overlapping checks
    // when a health check takes longer than the interval period.
    // healthCheckStopped guards against a concurrent in-flight check scheduling a new
    // timer after stopHealthCheck() has been called (e.g., during runner teardown).
    let healthCheckStopped = false;
    let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let healthCheckTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const startHealthCheck = () => {
      const scheduleNext = () => {
        healthCheckTimer = setTimeout(async () => {
          if (healthCheckStopped || this.opts.abortSignal?.aborted) {
            return;
          }
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              healthCheckTimeoutHandle = setTimeout(
                () => reject(new Error("Health check timeout")),
                HEALTH_CHECK_TIMEOUT_MS,
              );
            });
            try {
              await Promise.race([bot.api.getMe(), timeoutPromise]);
            } finally {
              if (healthCheckTimeoutHandle) {
                clearTimeout(healthCheckTimeoutHandle);
                healthCheckTimeoutHandle = undefined;
              }
            }
            logVerbose("[telegram] Health check passed");
          } catch (err) {
            if (healthCheckStopped || this.opts.abortSignal?.aborted) {
              return;
            }
            // Distinguish connection/network errors from transient API errors (429, 5xx).
            // Only restart polling for actual stale connections; for transient errors,
            // log a warning and let the next scheduled check retry.
            if (isRecoverableTelegramNetworkError(err, { context: "polling" })) {
              staleConnectionDetected = true;
              this.opts.log(
                `[telegram] Health check failed (stale connection detected): ${formatErrorMessage(err)}; restarting polling...`,
              );
              void stopRunner();
              return; // Don't schedule next check; runner restart will create a new watchdog
            }
            // Transient API error (e.g. 429 rate-limit, 5xx server error, or timeout) --
            // log and reschedule; no restart needed.
            this.opts.log(
              `[telegram] Health check transient error: ${formatErrorMessage(err)}; will retry at next interval.`,
            );
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
      // Clear the inner timeout handle to avoid keeping the event loop alive
      // for up to HEALTH_CHECK_TIMEOUT_MS after teardown.
      if (healthCheckTimeoutHandle) {
        clearTimeout(healthCheckTimeoutHandle);
        healthCheckTimeoutHandle = undefined;
      }
    };

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    startHealthCheck();
    try {
      await runner.task();
      // Abort takes highest priority -- always exit cleanly when signaled.
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      if (staleConnectionDetected) {
        // Runner was stopped due to health check failure; continue to restart
        // without backoff since this is a controlled recovery restart.
        this.#forceRestarted = false;
        this.#restartAttempts = 0;
        return "continue";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } catch (err) {
      this.#forceRestarted = false;
      if (this.opts.abortSignal?.aborted) {
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      if (isConflict) {
        this.#webhookCleared = false;
      }
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      stopHealthCheck();
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await stopRunner();
      await stopBot();
      this.#activeRunner = undefined;
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
    }
  }
}

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
