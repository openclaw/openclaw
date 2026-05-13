import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function mapLegacyAgentSessionDirs(agentsDir: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, "sessions"))
    .toSorted((a, b) => a.localeCompare(b));
}

export async function resolveLegacyAgentSessionDirsFromAgentsDir(
  agentsDir: string,
): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return mapLegacyAgentSessionDirs(agentsDir, entries);
}

export function resolveLegacyAgentSessionDirsFromAgentsDirSync(agentsDir: string): string[] {
  let entries: Dirent[] = [];
  try {
    entries = fsSync.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return mapLegacyAgentSessionDirs(agentsDir, entries);
}

export async function resolveLegacyAgentSessionDirs(stateDir: string): Promise<string[]> {
  return await resolveLegacyAgentSessionDirsFromAgentsDir(path.join(stateDir, "agents"));
}
