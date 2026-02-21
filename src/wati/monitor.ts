import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveWatiAccount } from "./accounts.js";
import { startWatiWebhook, type WatiInboundMessage } from "./webhook.js";

export type MonitorWatiOpts = {
  apiToken?: string;
  apiBaseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPort?: number;
  webhookPath?: string;
  webhookHost?: string;
  webhookSecret?: string;
  onMessage?: (msg: WatiInboundMessage) => void;
};

/**
 * Start the WATI provider: resolve account config, start webhook server, handle lifecycle.
 */
export async function monitorWatiProvider(opts: MonitorWatiOpts = {}) {
  const log = opts.runtime?.log ?? console.log;
  const logError = opts.runtime?.error ?? console.error;

  const cfg = opts.config ?? loadConfig();
  const account = resolveWatiAccount({
    cfg,
    accountId: opts.accountId,
  });

  const apiToken = opts.apiToken?.trim() || account.apiToken;
  if (!apiToken) {
    throw new Error(
      `WATI API token missing for account "${account.accountId}" (set channels.wati.accounts.${account.accountId}.apiToken or WATI_API_TOKEN for default).`,
    );
  }

  const port = opts.webhookPort ?? account.config.webhookPort ?? 3001;
  const path = opts.webhookPath ?? account.config.webhookPath ?? "/webhook/wati";
  const host = opts.webhookHost ?? account.config.webhookHost;
  const secret = opts.webhookSecret ?? account.config.webhookSecret;

  const onMessage = opts.onMessage ?? (() => {});

  const { server, close } = startWatiWebhook({
    port,
    path,
    host,
    webhookSecret: secret,
    abortSignal: opts.abortSignal,
    onMessage,
  });

  server.on("listening", () => {
    log(`[wati] Webhook server listening on ${host || "0.0.0.0"}:${port}${path}`);
  });

  server.on("error", (err) => {
    logError(`[wati] Webhook server error: ${String(err)}`);
  });

  // Graceful shutdown
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener(
      "abort",
      () => {
        close().catch((err) => {
          logError(`[wati] Error closing webhook server: ${String(err)}`);
        });
      },
      { once: true },
    );
  }

  return { server, close, account };
}
