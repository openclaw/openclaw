import fs from "node:fs";
import path from "node:path";
import { AUTH_STATE_FILENAME } from "../../../agents/auth-profiles/path-constants.js";
import { resolveAuthStatePath } from "../../../agents/auth-profiles/paths.js";
import {
  coerceAuthProfileState,
  savePersistedAuthProfileState,
} from "../../../agents/auth-profiles/state.js";
import { resolveStateDir } from "../../../config/paths.js";
import { loadJsonFile } from "../../../infra/json-file.js";

export function legacyAuthProfileStateFileExists(agentDir?: string): boolean {
  try {
    return fs.statSync(resolveAuthStatePath(agentDir)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacyAuthProfileStateFileToSqlite(agentDir?: string): { imported: boolean } {
  const statePath = resolveAuthStatePath(agentDir);
  if (!legacyAuthProfileStateFileExists(agentDir)) {
    return { imported: false };
  }
  const legacyState = coerceAuthProfileState(loadJsonFile(statePath));
  savePersistedAuthProfileState(legacyState, agentDir);
  try {
    fs.unlinkSync(statePath);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true };
}

export function discoverLegacyAuthProfileStateAgentDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const agentsDir = path.join(resolveStateDir(env), "agents");
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentDir = path.join(agentsDir, entry.name, "agent");
      if (fs.existsSync(path.join(agentDir, AUTH_STATE_FILENAME))) {
        out.push(agentDir);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  return out;
}
