import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import { resolveDingTalkAccount } from "./accounts.js";
import { resolveDingTalkConfig } from "./config.js";
import { loadDingTalkStreamModule } from "./deps.js";
import { processDingTalkMessage } from "./message.js";

const { DWClient, TOPIC_ROBOT } = loadDingTalkStreamModule();

const logger = getChildLogger({ module: "dingtalk-monitor" });
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

function cleanupProcessedMessages() {
  const now = Date.now();
  for (const [msgId, ts] of processedMessages.entries()) {
    if (now - ts > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(msgId);
    }
  }
}

function markMessageProcessed(messageId?: string) {
  if (!messageId) {
    return;
  }
  processedMessages.set(messageId, Date.now());
  if (processedMessages.size >= 100) {
    cleanupProcessedMessages();
  }
}

function isMessageProcessed(messageId?: string) {
  if (!messageId) {
    return false;
  }
  return processedMessages.has(messageId);
}

export async function monitorDingTalkProvider(opts: {
  config?: OpenClawConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onInbound?: () => void;
}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveDingTalkAccount({ cfg, accountId: opts.accountId });
  const dtCfg = resolveDingTalkConfig({ cfg, accountId: account.accountId });

  if (!account.config.clientId || !account.config.clientSecret) {
    throw new Error(`DingTalk credentials missing for account ${account.accountId}`);
  }
  if (!dtCfg.enabled || !account.enabled) {
    logger.info(`DingTalk account ${account.accountId} disabled, skipping`);
    return;
  }

  const client = new DWClient({
    clientId: account.config.clientId,
    clientSecret: account.config.clientSecret,
    debug: account.config.debug || false,
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (res: unknown) => {
    const msg = res as { headers?: { messageId?: string }; data?: string };
    const messageId = msg.headers?.messageId;
    if (messageId) {
      client.socketCallBackResponse(messageId, { success: true });
    }
    if (messageId && isMessageProcessed(messageId)) {
      return;
    }
    markMessageProcessed(messageId);
    opts.onInbound?.();

    try {
      const data = JSON.parse(msg.data as string);
      await processDingTalkMessage({
        cfg,
        accountId: account.accountId,
        data,
        log: logger,
        resolvedConfig: dtCfg,
      });
    } catch (err) {
      logger.error(`DingTalk message processing error: ${String(err)}`);
    }
  });

  await client.connect();
  logger.info(`DingTalk stream connected (${account.accountId})`);
  opts.onConnected?.();

  const stop = () => {
    try {
      client.disconnect();
    } catch {
      // best-effort shutdown
    }
    opts.onDisconnected?.();
  };

  const abortSignal = opts.abortSignal;
  if (!abortSignal) {
    await new Promise<void>(() => {});
    return;
  }

  if (abortSignal.aborted) {
    logger.info(`DingTalk stream stopping (${account.accountId})`);
    stop();
    return;
  }

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      logger.info(`DingTalk stream stopping (${account.accountId})`);
      abortSignal.removeEventListener("abort", onAbort);
      stop();
      resolve();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
