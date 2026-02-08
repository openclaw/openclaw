import type { CautionConfig } from "../config/types.tools.js";

/** Tools that ingest external untrusted content default to caution ON. */
export const DEFAULT_CAUTION_TOOLS: Record<string, boolean> = {
  web_fetch: true,
  web_search: false,
  browser: true,
  // email/webhook are hook-triggered (not direct tools today),
  // but if they become tools they would be true here.
};

/**
 * Determine whether a tool is cautioned.
 *
 * Resolution order:
 *  1. User config override (`tools.caution.tools.<name>`)
 *  2. Plugin metadata (`metadata.openclaw.caution`)
 *  3. Built-in defaults
 */
export function isToolCautioned(
  toolName: string,
  config?: CautionConfig,
  pluginMeta?: { caution?: boolean },
): boolean {
  if (config?.enabled === false) return false;
  if (config?.tools && toolName in config.tools) {
    return config.tools[toolName];
  }
  if (pluginMeta?.caution !== undefined) return pluginMeta.caution;
  return DEFAULT_CAUTION_TOOLS[toolName] ?? false;
}
