import { createServer } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });

  // Duplicate detection cache (Telegram may retry on timeout)
  const recentUpdates = new Set<number>();
  const UPDATE_CACHE_TTL = 60000; // 1 minute

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer(async (req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }

    // Read request body with error handling
    let body: string;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    } catch (err) {
      runtime.log?.(`Failed to read request body: ${formatErrorMessage(err)}`);
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    // Parse update
    let update;
    try {
      update = JSON.parse(body);
    } catch (err) {
      runtime.log?.(`Invalid JSON in webhook: ${formatErrorMessage(err)}`);
      res.writeHead(400);
      res.end();
      return;
    }

    // Check for duplicate (Telegram retries on timeout)
    // Ensure update_id is a number for type-safe duplicate detection
    const updateIdRaw = update.update_id;
    const updateId =
      typeof updateIdRaw === "number"
        ? updateIdRaw
        : typeof updateIdRaw === "string"
          ? Number.parseInt(updateIdRaw, 10)
          : undefined;

    if (updateId !== undefined && !Number.isNaN(updateId)) {
      if (recentUpdates.has(updateId)) {
        runtime.log?.(`Duplicate update ${updateId}, skipping`);
        res.writeHead(200);
        res.end("ok");
        return;
      }
    }

    // Validate secret token
    if (opts.secret) {
      const token = req.headers["x-telegram-bot-api-secret-token"];
      if (token !== opts.secret) {
        res.writeHead(403);
        res.end();
        return;
      }
    }

    // Add to duplicate cache
    if (updateId !== undefined && !Number.isNaN(updateId)) {
      recentUpdates.add(updateId);
      setTimeout(() => recentUpdates.delete(updateId), UPDATE_CACHE_TTL);
    }

    // CRITICAL FIX: Respond immediately (< 1 second)
    // Telegram requires response within ~5 seconds
    res.writeHead(200);
    res.end("ok");

    // Process asynchronously (don't await!)
    // This allows LLM processing to take as long as needed
    void (async () => {
      try {
        // Process update through bot handlers
        await bot.handleUpdate(update);

        if (diagnosticsEnabled) {
          logWebhookProcessed({
            channel: "telegram",
            updateType: "telegram-post",
            durationMs: Date.now() - startTime,
          });
        }
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        if (diagnosticsEnabled) {
          logWebhookError({
            channel: "telegram",
            updateType: "telegram-post",
            error: errMsg,
          });
        }
        runtime.log?.(`webhook processing failed: ${errMsg}`);
      }
    })();
  });

  const publicUrl =
    opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  await withTelegramApiErrorLogging({
    operation: "setWebhook",
    runtime,
    fn: () =>
      bot.api.setWebhook(publicUrl, {
        secret_token: opts.secret,
        allowed_updates: resolveTelegramAllowedUpdates(),
      }),
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  runtime.log?.(`webhook listening on ${publicUrl}`);

  const shutdown = () => {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
