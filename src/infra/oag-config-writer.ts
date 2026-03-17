import { loadConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("oag/config-writer");

type ConfigChange = {
  configPath: string;
  value: unknown;
};

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isValidOagConfigPath(p: string): boolean {
  // Accept both global OAG paths and channel-scoped OAG paths:
  //   gateway.oag.<rest>
  //   gateway.oag.channels.<channelId>.<rest>
  return p.startsWith("gateway.oag.");
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!isValidOagConfigPath(path)) {
    throw new Error(`OAG config path must start with "gateway.oag.": ${path}`);
  }
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = current[key];
    if (existing !== undefined && !isPlainObject(existing)) {
      throw new Error(
        `Cannot traverse config path "${path}": "${parts.slice(0, i + 1).join(".")}" is not a plain object`,
      );
    }
    if (!existing) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

export async function applyOagConfigChanges(
  changes: ConfigChange[],
  options?: { dryRun?: boolean },
): Promise<{ applied: boolean; config?: OpenClawConfig }> {
  if (changes.length === 0) {
    return { applied: false };
  }

  const currentConfig = loadConfig();
  const nextConfig: OpenClawConfig = JSON.parse(JSON.stringify(currentConfig));

  for (const change of changes) {
    log.info(`OAG config change: ${change.configPath} = ${JSON.stringify(change.value)}`);
    setNestedValue(nextConfig as Record<string, unknown>, change.configPath, change.value);
  }

  if (options?.dryRun) {
    log.info("OAG config changes computed (dry-run, not persisted)");
    return { applied: false, config: nextConfig };
  }

  try {
    await writeConfigFile(nextConfig);
    log.info(`OAG config persisted with ${changes.length} change(s)`);
    return { applied: true, config: nextConfig };
  } catch (err) {
    log.error(`Failed to write OAG config changes: ${String(err)}`);
    return { applied: false };
  }
}
