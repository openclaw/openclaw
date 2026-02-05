import * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuConfig } from "./config.js";
import { normalizeFeishuDomain } from "./domain.js";
import { processFeishuMessage } from "./message.js";
import { probeFeishu } from "./probe.js";

const logger = getChildLogger({ module: "feishu-monitor" });

export type MonitorFeishuOpts = {
  appId?: string;
  appSecret?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: opts.accountId,
  });

  const appId = opts.appId?.trim() || account.config.appId;
  const appSecret = opts.appSecret?.trim() || account.config.appSecret;
  const domain = normalizeFeishuDomain(account.config.domain);
  const accountId = account.accountId;

  if (!appId || !appSecret) {
    throw new Error(
      `Feishu app ID/secret missing for account "${accountId}" (set channels.feishu.accounts.${accountId}.appId/appSecret or FEISHU_APP_ID/FEISHU_APP_SECRET).`,
    );
  }

  // Resolve effective config for this account
  const feishuCfg = resolveFeishuConfig({ cfg, accountId });

  // Check if account is enabled
  if (!feishuCfg.enabled) {
    logger.info(`Feishu account "${accountId}" is disabled, skipping monitor`);
    return;
  }

  // Create Lark client for API calls
  const client = new Lark.Client({
    appId,
    appSecret,
    ...(domain ? { domain } : {}),
    logger: {
      debug: (msg) => {
        logger.debug?.(msg);
      },
      info: (msg) => {
        logger.info(msg);
      },
      warn: (msg) => {
        logger.warn(msg);
      },
      error: (msg) => {
        logger.error(msg);
      },
      trace: (msg) => {
        logger.silly?.(msg);
      },
    },
  });

  // Get bot's open_id for detecting mentions in group chats
  const probeResult = await probeFeishu(appId, appSecret, 5000, domain);
  const botOpenId = probeResult.bot?.openId ?? undefined;
  if (!botOpenId) {
    logger.warn(`Could not get bot open_id, group mention detection may not work correctly`);
  }

  // Create event dispatcher
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      logger.info(`Received Feishu message event`);
      try {
        await processFeishuMessage(client, data, appId, {
          cfg,
          accountId,
          resolvedConfig: feishuCfg,
          credentials: { appId, appSecret, domain },
          botName: account.name,
          botOpenId,
        });
      } catch (err) {
        logger.error(`Error processing Feishu message: ${String(err)}`);
      }
    },
  });

  // Create WebSocket client
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    ...(domain ? { domain } : {}),
    loggerLevel: Lark.LoggerLevel.info,
    logger: {
      debug: (msg) => {
        logger.debug?.(msg);
      },
      info: (msg) => {
        logger.info(msg);
      },
      warn: (msg) => {
        logger.warn(msg);
      },
      error: (msg) => {
        logger.error(msg);
      },
      trace: (msg) => {
        logger.silly?.(msg);
      },
    },
  });

  // Handle abort signal
  const handleAbort = () => {
    logger.info("Stopping Feishu WS client...");
    // WSClient doesn't have a stop method exposed, but it should handle disconnection
    // We'll let the process handle cleanup
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", handleAbort, { once: true });
  }

  try {
    logger.info("Starting Feishu WebSocket client...");
    await wsClient.start({ eventDispatcher });
    logger.info("Feishu WebSocket connection established");

    // The WSClient.start() should keep running until disconnected
    // If it returns, we need to keep the process alive
    // Wait for abort signal
    if (opts.abortSignal) {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted) {
          resolve();
          return;
        }
        opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    } else {
      // If no abort signal, wait indefinitely
      await new Promise<void>(() => {});
    }
  } finally {
    if (opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", handleAbort);
    }
  }
}
