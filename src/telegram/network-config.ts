import process from "node:process";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { isWSL2Sync } from "../infra/wsl.js";

export const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV =
  "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";

export type TelegramAutoSelectFamilyDecision = {
  value: boolean | null;
  source?: string;
};

let wsl2SyncCache: boolean | undefined;

function isWSL2SyncCached(): boolean {
  if (typeof wsl2SyncCache === "boolean") {
    return wsl2SyncCache;
  }
  wsl2SyncCache = isWSL2Sync();
  return wsl2SyncCache;
}

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
  nodeMajor?: number;
}): TelegramAutoSelectFamilyDecision {
  const env = params?.env ?? process.env;
  const nodeMajor =
    typeof params?.nodeMajor === "number"
      ? params.nodeMajor
      : Number(process.versions.node.split(".")[0]);

  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: true, source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: false, source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { value: params.network.autoSelectFamily, source: "config" };
  }
  // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to use IPv4 directly
  if (isWSL2SyncCached()) {
    return { value: false, source: "default-wsl2" };
  }
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { value: true, source: "default-node22" };
  }
  return { value: null };
}

export function resetTelegramNetworkConfigStateForTests(): void {
  wsl2SyncCache = undefined;
}
