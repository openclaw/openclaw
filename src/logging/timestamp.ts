import fs from "node:fs";
import json5 from "json5";
import { resolveUserTimezone } from "../agents/date-time.js";
import { resolveConfigPath } from "../config/paths.js";

let _cachedTz: string | null = null;

/**
 * Resolve the user's configured timezone, reading from config on first call.
 * Caches the result for the lifetime of the process.
 */
export function getConfiguredTimezone(): string {
  if (_cachedTz) {
    return _cachedTz;
  }
  let configured: string | undefined;
  try {
    const configPath = resolveConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = json5.parse(raw);
      configured = parsed?.agents?.defaults?.userTimezone;
    }
  } catch {
    // fall through — resolveUserTimezone handles missing config
  }
  _cachedTz = resolveUserTimezone(configured);
  return _cachedTz;
}

/** Reset cached timezone (for testing). */
export function _resetCachedTimezone(): void {
  _cachedTz = null;
}
