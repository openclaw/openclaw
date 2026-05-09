import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import {
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../../../state/openclaw-state-kv.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

const UPDATE_CHECK_FILENAME = "update-check.json";
const UPDATE_CHECK_SCOPE = "runtime.update-check";
const UPDATE_CHECK_KEY = "state";

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function resolveLegacyUpdateCheckPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), UPDATE_CHECK_FILENAME);
}

function coerceUpdateCheckState(value: unknown): UpdateCheckState {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UpdateCheckState)
    : {};
}

function writeState(state: UpdateCheckState, env: NodeJS.ProcessEnv = process.env): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    UPDATE_CHECK_SCOPE,
    UPDATE_CHECK_KEY,
    state as unknown as OpenClawStateJsonValue,
    sqliteOptionsForEnv(env),
  );
}

async function readLegacyStateFile(filePath: string): Promise<UpdateCheckState> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return coerceUpdateCheckState(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function legacyUpdateCheckFileExists(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await fs.access(resolveLegacyUpdateCheckPath(env));
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyUpdateCheckFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ imported: boolean }> {
  const filePath = resolveLegacyUpdateCheckPath(env);
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false };
    }
    throw error;
  }
  const state = await readLegacyStateFile(filePath);
  writeState(state, env);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true };
}
