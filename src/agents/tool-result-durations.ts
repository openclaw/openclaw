import type { OpenClawConfig } from "../config/config.js";

export function isToolResultDurationTrackingEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.toolResultDurations?.enabled !== false;
}
