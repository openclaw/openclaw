import { createServer } from "node:http";
import type {
  IncomingMessage as NodeIncomingMessage,
  ServerResponse as NodeServerResponse,
} from "node:http";
import { webhookCallback } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { installRequestBodyLimitGuard } from "../infra/http-body.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_PATH = "/telegram-webhook";
const DEFAULT_TELEGRAM_ACCOUNT_ID = "default";

type WebhookRoute = {
  accountId: string;
  diagnosticsEnabled: boolean;
  handle: (req: NodeIncomingMessage, res: NodeServerResponse) => void;
  stopBot: () => void;
};

type SharedWebhookServer = {
  server: ReturnType<typeof createServer>;
  routes: Map<string, WebhookRoute>;
  diagnosticsRefs: number;
  listenPromise: Promise<void> | null;
};

const sharedWebhookServers = new Map<string, SharedWebhookServer>();

function resolveRequestPath(url: string | undefined): string {
  const raw = typeof url === "string" ? url : "";
  const question = raw.indexOf("?");
  return question === -1 ? raw : raw.slice(0, question);
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_WEBHOOK_PATH;
  }
  const rawPath = resolveRequestPath(trimmed);
  if (!rawPath) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function resolveWebhookPath(path: string | undefined, accountId: string): string {
  if (typeof path === "string" && path.trim()) {
    return normalizeWebhookPath(path);
  }
  if (accountId !== DEFAULT_TELEGRAM_ACCOUNT_ID) {
    return `${DEFAULT_WEBHOOK_PATH}/${encodeURIComponent(accountId)}`;
  }
  return DEFAULT_WEBHOOK_PATH;
}

function buildServerKey(host: string, port: number, healthPath: string): string {
  return `${host}:${port}:${healthPath}`;
}

function createSharedWebhookServer(params: { healthPath: string }): SharedWebhookServer {
  const routes = new Map<string, WebhookRoute>();
  const server = createServer((req, res) => {
    const reqPath = resolveRequestPath(req.url);
    if (reqPath === params.healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const route = routes.get(reqPath);
    if (!route || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    route.handle(req, res);
  });
  return {
    server,
    routes,
    diagnosticsRefs: 0,
    listenPromise: null,
  };
}

async function ensureServerListening(params: {
  shared: SharedWebhookServer;
  port: number;
  host: string;
  key: string;
}): Promise<void> {
  if (params.shared.server.listening) {
    return;
  }
  if (!params.shared.listenPromise) {
    params.shared.listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        params.shared.server.off("listening", onListening);
        params.shared.listenPromise = null;
        sharedWebhookServers.delete(params.key);
        reject(err);
      };
      const onListening = () => {
        params.shared.server.off("error", onError);
        resolve();
      };
      params.shared.server.once("error", onError);
      params.shared.server.once("listening", onListening);
      params.shared.server.listen(params.port, params.host);
    });
  }
  await params.shared.listenPromise;
}

function resolveListeningPort(
  server: ReturnType<typeof createServer>,
  fallbackPort: number,
): number {
  const address = server.address();
  if (address && typeof address === "object" && typeof address.port === "number") {
    return address.port;
  }
  return fallbackPort;
}

function closeServerSafe(server: ReturnType<typeof createServer>): void {
  try {
    server.close();
  } catch {
    // no-op
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
  const accountId = opts.accountId?.trim() || DEFAULT_TELEGRAM_ACCOUNT_ID;
  const path = resolveWebhookPath(opts.path, accountId);
  const healthPath = normalizeWebhookPath(opts.healthPath ?? "/healthz");
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  const secret = typeof opts.secret === "string" ? opts.secret.trim() : "";
  if (!secret) {
    throw new Error(
      "Telegram webhook mode requires a non-empty secret token. " +
        "Set channels.telegram.webhookSecret in your config.",
    );
  }
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId,
  });
  const handler = webhookCallback(bot, "http", {
    secretToken: secret,
    onTimeout: "return",
    timeoutMilliseconds: TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS,
  });

  const serverKey = buildServerKey(host, port, healthPath);
  let shared = sharedWebhookServers.get(serverKey);
  if (!shared) {
    shared = createSharedWebhookServer({ healthPath });
    sharedWebhookServers.set(serverKey, shared);
  }
  const conflictingRoute = shared.routes.get(path);
  if (conflictingRoute && conflictingRoute.accountId !== accountId) {
    throw new Error(
      [
        `Telegram webhook path conflict on ${host}:${port}${path}.`,
        `Account "${accountId}" collides with account "${conflictingRoute.accountId}".`,
        "Set unique webhookPath per account.",
      ].join(" "),
    );
  }
  if (conflictingRoute && conflictingRoute.accountId === accountId) {
    throw new Error(
      `Telegram webhook path ${path} is already active for account "${accountId}" on ${host}:${port}.`,
    );
  }

  const route: WebhookRoute = {
    accountId,
    diagnosticsEnabled,
    stopBot: () => {
      void bot.stop();
    },
    handle: (req, res) => {
      const startTime = Date.now();
      if (diagnosticsEnabled) {
        logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
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
          .then(() => {
            if (diagnosticsEnabled) {
              logWebhookProcessed({
                channel: "telegram",
                updateType: "telegram-post",
                durationMs: Date.now() - startTime,
              });
            }
          })
          .catch((err) => {
            if (guard.isTripped()) {
              return;
            }
            const errMsg = formatErrorMessage(err);
            if (diagnosticsEnabled) {
              logWebhookError({
                channel: "telegram",
                updateType: "telegram-post",
                error: errMsg,
              });
            }
            runtime.log?.(`webhook handler failed: ${errMsg}`);
            if (!res.headersSent) {
              res.writeHead(500);
            }
            res.end();
          })
          .finally(() => {
            guard.dispose();
          });
        return;
      }
      guard.dispose();
    },
  };

  shared.routes.set(path, route);
  if (diagnosticsEnabled) {
    shared.diagnosticsRefs += 1;
    if (shared.diagnosticsRefs === 1) {
      startDiagnosticHeartbeat();
    }
  }

  const cleanupRoute = () => {
    const active = sharedWebhookServers.get(serverKey);
    if (!active) {
      route.stopBot();
      return;
    }
    const registered = active.routes.get(path);
    if (registered === route) {
      active.routes.delete(path);
      if (route.diagnosticsEnabled) {
        active.diagnosticsRefs = Math.max(0, active.diagnosticsRefs - 1);
        if (active.diagnosticsRefs === 0) {
          stopDiagnosticHeartbeat();
        }
      }
      route.stopBot();
    }
    if (active.routes.size === 0) {
      sharedWebhookServers.delete(serverKey);
      closeServerSafe(active.server);
    }
  };

  try {
    await ensureServerListening({
      shared,
      host,
      port,
      key: serverKey,
    });
    const resolvedPort = resolveListeningPort(shared.server, port);
    const publicUrl =
      opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${resolvedPort}${path}`;

    await withTelegramApiErrorLogging({
      operation: "setWebhook",
      runtime,
      fn: () =>
        bot.api.setWebhook(publicUrl, {
          secret_token: secret,
          allowed_updates: resolveTelegramAllowedUpdates(),
        }),
    });

    runtime.log?.(`webhook listening on ${publicUrl}`);
  } catch (err) {
    cleanupRoute();
    throw err;
  }

  let stopped = false;
  const shutdown = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    cleanupRoute();
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server: shared.server, bot, stop: shutdown };
}
