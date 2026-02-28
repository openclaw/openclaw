import type { UnpairedResponseMode } from "../config/types.channels.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Get the unpaired response mode from config, with a secure default.
 * @param cfg - The OpenClaw config object
 * @returns The unpaired response mode (defaults to "silent" for security)
 */
export function getUnpairedResponseMode(cfg: OpenClawConfig): UnpairedResponseMode {
  return cfg.channels?.defaults?.unpairedResponse ?? "silent";
}
