import fs from "node:fs";

import type { ClawdisConfig } from "../config/config.js";

export type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = {
  token: string;
  source: TelegramTokenSource;
};

type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveTelegramToken(
  cfg?: ClawdisConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const envToken = (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const tokenFile = cfg?.telegram?.tokenFile?.trim();
  if (tokenFile) {
    if (!fs.existsSync(tokenFile)) {
      opts.logMissingFile?.(`telegram.tokenFile not found: ${tokenFile}`);
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(`telegram.tokenFile read failed: ${String(err)}`);
      return { token: "", source: "none" };
    }
    return { token: "", source: "none" };
  }

  const configToken = cfg?.telegram?.botToken?.trim();
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  return { token: "", source: "none" };
}
