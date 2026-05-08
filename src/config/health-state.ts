import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { isRecord } from "../utils.js";

export type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

export type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

export type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

const CONFIG_HEALTH_SCOPE = "config.health";
const CONFIG_HEALTH_KEY = "current";

function configHealthDbOptions(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...env,
      HOME: env.HOME ?? homedir(),
    },
  };
}

export function readConfigHealthStateFromSqlite(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): ConfigHealthState {
  try {
    const parsed = readOpenClawStateKvJson(
      CONFIG_HEALTH_SCOPE,
      CONFIG_HEALTH_KEY,
      configHealthDbOptions(env, homedir),
    );
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

export function writeConfigHealthStateToSqlite(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  state: ConfigHealthState,
): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    CONFIG_HEALTH_SCOPE,
    CONFIG_HEALTH_KEY,
    state as unknown as OpenClawStateJsonValue,
    configHealthDbOptions(env, homedir),
  );
}
