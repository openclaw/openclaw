import * as Lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import { loadConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { normalizeFeishuDomain } from "./domain.js";

const logger = getChildLogger({ module: "feishu-client" });

function readFileIfExists(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolveAppSecret(config?: {
  appSecret?: string;
  appSecretFile?: string;
}): string | undefined {
  const direct = config?.appSecret?.trim();
  if (direct) {
    return direct;
  }
  return readFileIfExists(config?.appSecretFile);
}

export function getFeishuClient(accountIdOrAppId?: string, explicitAppSecret?: string) {
  const cfg = loadConfig();
  const feishuCfg = cfg.channels?.feishu;

  let appId: string | undefined;
  let appSecret: string | undefined = explicitAppSecret?.trim() || undefined;
  let domain: string | undefined;

  // Determine if we received an accountId or an appId
  const isAppId = accountIdOrAppId?.startsWith("cli_");
  const accountId = isAppId ? undefined : accountIdOrAppId || DEFAULT_ACCOUNT_ID;

  if (!appSecret && feishuCfg?.accounts) {
    if (isAppId) {
      // When given an appId, find the account with matching appId
      for (const [, acc] of Object.entries(feishuCfg.accounts)) {
        if (acc.appId === accountIdOrAppId) {
          appId = acc.appId;
          appSecret = resolveAppSecret(acc);
          domain = acc.domain ?? feishuCfg?.domain;
          break;
        }
      }
      // If not found in accounts, use the appId directly (secret from first account as fallback)
      if (!appSecret) {
        appId = accountIdOrAppId;
        const firstKey = Object.keys(feishuCfg.accounts)[0];
        if (firstKey) {
          const acc = feishuCfg.accounts[firstKey];
          appSecret = resolveAppSecret(acc);
          domain = acc.domain ?? feishuCfg?.domain;
        }
      }
    } else if (accountId && feishuCfg.accounts[accountId]) {
      // Try to get from accounts config by accountId
      const acc = feishuCfg.accounts[accountId];
      appId = acc.appId;
      appSecret = resolveAppSecret(acc);
      domain = acc.domain ?? feishuCfg?.domain;
    } else if (!accountId) {
      // Fallback to first account if accountId is not specified
      const firstKey = Object.keys(feishuCfg.accounts)[0];
      if (firstKey) {
        const acc = feishuCfg.accounts[firstKey];
        appId = acc.appId;
        appSecret = resolveAppSecret(acc);
        domain = acc.domain ?? feishuCfg?.domain;
      }
    }
  }

  // Fallback to top-level feishu config (for backward compatibility)
  if (!appId && feishuCfg?.appId) {
    appId = feishuCfg.appId.trim();
  }
  if (!appSecret) {
    appSecret = resolveAppSecret(feishuCfg);
  }
  if (!domain) {
    domain = feishuCfg?.domain;
  }

  // Environment variables fallback
  if (!appId) {
    appId = process.env.FEISHU_APP_ID?.trim();
  }
  if (!appSecret) {
    appSecret = process.env.FEISHU_APP_SECRET?.trim();
  }

  if (!appId || !appSecret) {
    throw new Error(
      "Feishu app ID/secret not configured. Set channels.feishu.accounts.<id>.appId/appSecret (or appSecretFile) or FEISHU_APP_ID/FEISHU_APP_SECRET.",
    );
  }

  const resolvedDomain = normalizeFeishuDomain(domain);

  const client = new Lark.Client({
    appId,
    appSecret,
    ...(resolvedDomain ? { domain: resolvedDomain } : {}),
    logger: {
      debug: (msg) => {
        logger.debug(msg);
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
        logger.silly(msg);
      },
    },
  });

  return client;
}
