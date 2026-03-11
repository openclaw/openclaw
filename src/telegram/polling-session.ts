import { type RunOptions, run } from "@grammyjs/runner";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { getChannelActivity } from "../infra/channel-activity.js";
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
 * Maximum time to wait for `runner.task()` to settle after `runner.stop()`
 * has been called.  If the grammY runner hangs (stop doesn't resolve the
 * task promise), we force-break out of the polling cycle so `runUntilAbort`
 * can create a fresh bot + runner.
 */
const RUNNER_TASK_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Maximum time the polling loop can run without any inbound message before
 * we treat the connection as a zombie and force a restart.  This catches
 * the case where `getUpdates` calls succeed on schedule (so the existing
 * 90 s transport stall watchdog never fires) but the TCP connection has
 * silently stopped delivering data.
 *
 * Configurable via `channels.telegram.accounts.<id>.network.zombieTimeoutMs`
 * in openclaw.json; defaults to 15 minutes.
 */
const DEFAULT_ZOMBIE_INBOUND_TIMEOUT_MS = 15 * 60_000;

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
  /** Override the default zombie-inbound timeout (ms). 0 disables the check. */
  zombieInboundTimeoutMs?: number;
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
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "getUpdates") {
        lastGetUpdatesAt = Date.now();
      }
      const result = await prev(method, payload, signal);
      if (method === "getUpdates") {
        // Reset backoff after a *successful* getUpdates response so that
        // transient network blips don't permanently inflate the delay.
        this.#restartAttempts = 0;
      }
      return result;
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    let stopPromise: Promise<void> | undefined;
    let restartReason: "stall" | "zombie" | undefined;
    let stopRequested = false;
    const stopRunner = () => {
      stopRequested = true;
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

    const zombieTimeoutMs = this.opts.zombieInboundTimeoutMs ?? DEFAULT_ZOMBIE_INBOUND_TIMEOUT_MS;
    // Record the time when this polling cycle started so we don't trigger
    // the zombie check before the bot has had a reasonable window to
    // receive its first message.
    const pollingStartedAt = Date.now();

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
        return;
      }

      // --- existing transport-level stall check ---
      const elapsed = Date.now() - lastGetUpdatesAt;
      if (elapsed > POLL_STALL_THRESHOLD_MS && runner.isRunning()) {
        restartReason = "stall";
        this.opts.log(
          `[telegram] Polling stall detected (no getUpdates for ${formatDurationPrecise(elapsed)}); forcing restart.`,
        );
        void stopRunner();
        return;
      }

      // --- zombie polling check (issue #28622) ---
      // getUpdates calls may succeed on schedule, but the TCP connection
      // silently stops delivering data.  Detect this by checking how long
      // it has been since the last *actual* inbound message.
      if (zombieTimeoutMs > 0 && runner.isRunning()) {
        const activity = getChannelActivity({
          channel: "telegram",
          accountId: this.opts.accountId,
        });
        const lastInbound = activity.inboundAt;
        // Only check if we received a message *during this cycle* and it
        // has since gone stale.  The `lastInbound >= pollingStartedAt`
        // guard prevents false positives from cross-cycle timestamps
        // (the channel-activity singleton persists across restarts).
        if (lastInbound !== null && lastInbound >= pollingStartedAt) {
          const inboundAge = Date.now() - lastInbound;
          if (inboundAge > zombieTimeoutMs) {
            restartReason = "zombie";
            this.opts.log(
              `[telegram] Zombie polling detected (last inbound ${formatDurationPrecise(inboundAge)} ago, threshold ${formatDurationPrecise(zombieTimeoutMs)}); forcing restart.`,
            );
            void stopRunner();
            return;
          }
        }
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      // Wait for the runner task to complete, but guard against hangs.
      // If runner.stop() was called (e.g. by the stall/zombie watchdog) but
      // the grammY runner's task promise never settles, we force-break out
      // after a timeout so the outer loop can create a fresh bot + runner.
      const taskPromise = runner.task() ?? Promise.resolve();
      let drainTimedOut = false;
      // The drain timer only activates once stopRequested is true.
      // During healthy polling, runner.task() stays pending (that's normal)
      // and the drain timer never fires.
      const drainTimer = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!stopRequested) {
            return;
          }
          clearInterval(checkInterval);
          const t = setTimeout(() => {
            drainTimedOut = true;
            resolve();
          }, RUNNER_TASK_DRAIN_TIMEOUT_MS);
          if (typeof t === "object" && "unref" in t) {
            t.unref();
          }
          // Cancel the timer early if runner.task() settles on its own.
          taskPromise.then(
            () => clearTimeout(t),
            () => clearTimeout(t),
          );
        }, 1000);
        if (typeof checkInterval === "object" && "unref" in checkInterval) {
          checkInterval.unref();
        }
        // Also cancel the check interval if taskPromise settles normally.
        taskPromise.then(
          () => clearInterval(checkInterval),
          () => clearInterval(checkInterval),
        );
      });
      // Wrap taskPromise so rejections don't escape Promise.race unhandled.
      const safeTask = taskPromise.then(
        () => {},
        () => {},
      );
      await Promise.race([safeTask, drainTimer]);

      if (drainTimedOut) {
        // runner.task() hung — force restart.
        this.opts.log(
          `[telegram] runner.task() did not settle within ${formatDurationPrecise(RUNNER_TASK_DRAIN_TIMEOUT_MS)} after stop; forcing restart.`,
        );
        this.#forceRestarted = false;
        const shouldRestart = await this.#waitBeforeRestart(
          (delay) => `Telegram polling runner hung; restarting in ${delay}.`,
        );
        return shouldRestart ? "continue" : "exit";
      }
      // Task settled — re-await to propagate the original result/error.
      await taskPromise;

      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason =
        restartReason === "stall"
          ? "polling stall detected"
          : restartReason === "zombie"
            ? "zombie polling detected"
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
