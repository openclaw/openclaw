/**
 * Resolve the active config source from environment (file vs Nacos).
 * Avoid importing from ../io.js to prevent cycles: resolve → file → io.
 */

import { resolveConfigPath } from "../paths.js";
import { createFileConfigSource } from "./file.js";
import { createNacosConfigSource } from "./nacos.js";
import type { ConfigSource } from "./types.js";

const DEFAULT_NACOS_GROUP = "DEFAULT_GROUP";

function hasNacosEnv(env: NodeJS.ProcessEnv): boolean {
  const serverAddr = env.NACOS_SERVER_ADDR?.trim();
  const dataId = env.NACOS_DATA_ID?.trim();
  return Boolean(serverAddr && dataId);
}

/**
 * Resolve config source from environment.
 * - If OPENCLAW_CONFIG_SOURCE=nacos and NACOS_SERVER_ADDR, NACOS_DATA_ID are set,
 *   returns Nacos source (NACOS_GROUP optional, default DEFAULT_GROUP).
 * - Otherwise returns file source using resolveConfigPath(env).
 */
export function resolveConfigSource(env: NodeJS.ProcessEnv): ConfigSource {
  if (env.OPENCLAW_CONFIG_SOURCE === "nacos" && hasNacosEnv(env)) {
    const serverAddr = env.NACOS_SERVER_ADDR!.trim();
    const dataId = env.NACOS_DATA_ID!.trim();
    const group = env.NACOS_GROUP?.trim() || DEFAULT_NACOS_GROUP;
    const tenant = env.NACOS_NAMESPACE?.trim() || undefined;
    return createNacosConfigSource({ serverAddr, dataId, group, tenant, env });
  }
  const configPath = resolveConfigPath(env);
  return createFileConfigSource({ configPath, env });
}
