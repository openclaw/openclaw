import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { saveNodeHostConfig, type NodeHostConfig } from "../../../node-host/config.js";

const NODE_HOST_FILE = "node.json";

function resolveLegacyNodeHostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), NODE_HOST_FILE);
}

function coercePartialConfig(value: unknown): Partial<NodeHostConfig> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<NodeHostConfig>)
    : null;
}

export async function legacyNodeHostConfigFileExists(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await fs.access(resolveLegacyNodeHostConfigPath(env));
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyNodeHostConfigFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ imported: boolean }> {
  const filePath = resolveLegacyNodeHostConfigPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false };
    }
    throw error;
  }
  await saveNodeHostConfig((coercePartialConfig(JSON.parse(raw)) ?? {}) as NodeHostConfig, env);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true };
}
