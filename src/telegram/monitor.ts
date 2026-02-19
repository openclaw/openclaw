import { type RunOptions, run } from "@grammyjs/runner";
import { webhookCallback } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { installRequestBodyLimitGuard } from "../infra/http-body.js";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { registerTelegramHttpHandler } from "./http/index.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

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
      const secret = opts.webhookSecret ?? account.config.webhookSecret;
      if (!secret || !secret.trim()) {
        throw new Error(
          "Telegram webhook mode requires a non-empty secret token. " +
            "Set channels.telegram.webhookSecret in your config.",
        );
      }

      const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
      const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
      const TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS = 10_000;

      const handler = webhookCallback(bot, "http", {
        secretToken: secret.trim(),
        onTimeout: "return",
        timeoutMilliseconds: TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS,
      });

      const webhookHandler = (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const guard = installRequestBodyLimitGuard(req, res, {
          maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
          responseFormat: "text",
        });
        if (guard.isTripped()) {
          return;
        }
        const handled = handler(req, res);
        if (handled && typeof handled.catch === "function") {
          void handled
            .catch((err: unknown) => {
              if (guard.isTripped()) {
                return;
              }
              opts.runtime?.error?.(`telegram webhook handler failed: ${String(err)}`);
              if (!res.headersSent) {
                res.writeHead(500);
              }
              res.end();
            })
            .finally(() => guard.dispose());
        } else {
          guard.dispose();
        }
      };

      const unregister = registerTelegramHttpHandler({
        path: opts.webhookPath,
        handler: webhookHandler,
        log: opts.runtime?.log,
        accountId: account.accountId,
      });

      try {
        await withTelegramApiErrorLogging({
          operation: "setWebhook",
          runtime: opts.runtime,
          fn: () =>
            bot.api.setWebhook(opts.webhookUrl!, {
              secret_token: secret.trim(),
              allowed_updates: resolveTelegramAllowedUpdates(),
            }),
        });

        opts.runtime?.log?.(
          `telegram webhook registered at ${opts.webhookPath ?? "/telegram-webhook"}`,
        );

        // Wait for abort signal
        if (opts.abortSignal && !opts.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } finally {
        unregister();
      }

      await bot.stop();
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
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      }
    }
  } finally {
    unregisterHandler();
  }
}
