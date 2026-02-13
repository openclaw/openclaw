import type { IncomingMessage } from "node:http";
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

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}

async function listenWithRetry(opts: {
  server: ReturnType<typeof createServer>;
  port: number;
  host: string;
  runtime: RuntimeEnv;
  retries?: number;
  retryDelayMs?: number;
}) {
  const retries = opts.retries ?? 10;
  let delayMs = opts.retryDelayMs ?? 250;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          cleanup();
          reject(err);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          opts.server.off("error", onError);
          opts.server.off("listening", onListening);
        };

        opts.server.once("error", onError);
        opts.server.once("listening", onListening);
        opts.server.listen(opts.port, opts.host);
      });
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code !== "EADDRINUSE" || attempt === retries) {
        throw err;
      }
      opts.runtime.log?.(
        `telegram webhook bind failed (EADDRINUSE ${opts.host}:${opts.port}); retrying in ${delayMs}ms (${attempt + 1}/${retries})`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
}

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
  // Required when we manually call bot.handleUpdate (fast-ACK mode).
  await bot.init();

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer((req, res) => {
    let responded = false;
    const safeRespond = (status: number, body?: string) => {
      if (responded || res.headersSent || res.writableEnded) {
        return;
      }
      responded = true;
      res.writeHead(status);
      res.end(body);
    };

    if (req.url === healthPath) {
      safeRespond(200, "ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      safeRespond(404);
      return;
    }

    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }

    void (async () => {
      try {
        if (opts.secret) {
          const header = req.headers["x-telegram-bot-api-secret-token"];
          const provided = Array.isArray(header) ? header[0] : header;
          if (!provided || provided !== opts.secret) {
            safeRespond(401);
            return;
          }
        }

        const raw = await readRequestBody(req);
        // ACK asap after parsing the request body, before any tool/model work.
        safeRespond(200, "ok");

        const update = JSON.parse(raw.toString("utf8"));

        setImmediate(() => {
          void (async () => {
            try {
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
              runtime.log?.(`webhook async handler failed: ${errMsg}`);
            }
          })();
        });
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        if (diagnosticsEnabled) {
          logWebhookError({
            channel: "telegram",
            updateType: "telegram-post",
            error: errMsg,
          });
        }
        runtime.log?.(`webhook handler failed: ${errMsg}`);
        safeRespond(500);
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

  await listenWithRetry({ server, port, host, runtime });
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
