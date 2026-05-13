import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  normalizeUpdateCheckStateSnapshot,
  writeUpdateCheckStateToSqlite,
} from "../../../infra/update-check-state.js";

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

function resolveLegacyUpdateCheckPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), UPDATE_CHECK_FILENAME);
}

function writeState(state: UpdateCheckState, env: NodeJS.ProcessEnv = process.env): void {
  writeUpdateCheckStateToSqlite(state, env);
}

async function readLegacyStateFile(filePath: string): Promise<UpdateCheckState> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeUpdateCheckStateSnapshot(JSON.parse(raw));
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
