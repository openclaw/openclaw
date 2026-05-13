import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentDir } from "../../../agents/agent-scope.js";
import { writeStoredModelsConfigRaw } from "../../../agents/models-config-store.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";

function resolveCandidateModelConfigPaths(params: {
  env: NodeJS.ProcessEnv;
  cfg?: OpenClawConfig;
}): string[] {
  const paths = new Set<string>();
  const stateDir = resolveStateDir(params.env);
  paths.add(path.join(resolveDefaultAgentDir(params.cfg ?? {}), "models.json"));

  const agentsDir = path.join(stateDir, "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.add(path.join(agentsDir, entry.name, "agent", "models.json"));
      }
    }
  } catch {
    // no legacy agent directory
  }
  return [...paths];
}

export function legacyModelsConfigFilesExist(params: {
  env: NodeJS.ProcessEnv;
  cfg?: OpenClawConfig;
}): boolean {
  return resolveCandidateModelConfigPaths(params).some((filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
}

export function importLegacyModelsConfigFilesToSqlite(params: {
  env: NodeJS.ProcessEnv;
  cfg?: OpenClawConfig;
}): { imported: number; removed: number } {
  let imported = 0;
  let removed = 0;
  for (const filePath of resolveCandidateModelConfigPaths(params)) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    JSON.parse(raw);
    writeStoredModelsConfigRaw(path.dirname(filePath), raw, { env: params.env });
    imported += 1;
    try {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // Import succeeded; a later doctor pass can remove the stale file.
    }
  }
  return { imported, removed };
}
