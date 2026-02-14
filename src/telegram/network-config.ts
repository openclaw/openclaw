import process from "node:process";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { isTruthyEnvValue } from "../infra/env.js";

export const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV =
  "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";

export type TelegramAutoSelectFamilyDecision = {
  value: boolean | null;
  source?: string;
};

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
  nodeMajor?: number;
  platform?: NodeJS.Platform;
}): TelegramAutoSelectFamilyDecision {
  const env = params?.env ?? process.env;
  const nodeMajor =
    typeof params?.nodeMajor === "number"
      ? params.nodeMajor
      : Number(process.versions.node.split(".")[0]);
  const platform = params?.platform ?? process.platform;

  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: true, source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: false, source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { value: params.network.autoSelectFamily, source: "config" };
  }
  // On macOS (darwin), disabling autoSelectFamily causes fetch to fail with
  // ConnectTimeoutError. The Happy Eyeballs workaround for Node 22
  // (nodejs/node#54359) must be skipped on this platform.
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22 && platform !== "darwin") {
    return { value: false, source: "default-node22" };
  }
  return { value: null };
}
