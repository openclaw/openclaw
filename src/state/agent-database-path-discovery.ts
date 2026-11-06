import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

/** Keep directory spellings until the consuming owner validates database identity. */
export async function listDefaultAgentDatabasePaths(
  stateDir: string,
): Promise<Array<{ agentId: string; path: string }>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(stateDir, "agents"), { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      agentId: entry.name,
      path: path.resolve(stateDir, "agents", entry.name, "agent", "openclaw-agent.sqlite"),
    }));
}
