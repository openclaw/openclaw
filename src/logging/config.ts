import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandPathWithRootOptions } from "../cli/argv.js";
import type { OpenClawConfig } from "../config/config.js";

type LoggingConfig = OpenClawConfig["logging"];

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

/**
 * Resolve the config file path using lightweight env-only logic.
 *
 * This intentionally avoids importing the full config/paths module — the
 * logger initialises very early and must not pull in heavy side effects.
 */
function resolveLoggingConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    if (explicit.startsWith("~/")) {
      return path.join(env.HOME ?? os.homedir(), explicit.slice(2));
    }
    return path.resolve(explicit);
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  const homeDir = env.HOME ?? os.homedir();
  if (stateDir) {
    const resolved = stateDir.startsWith("~/")
      ? path.join(homeDir, stateDir.slice(2))
      : path.resolve(stateDir);
    return path.join(resolved, "openclaw.json");
  }
  return path.join(homeDir, ".openclaw", "openclaw.json");
}

/**
 * Read the `logging` section from openclaw.json directly via the filesystem.
 *
 * Previous implementation used a late-bound `createRequire` → `require("../config/config.js")`
 * to load the full config module.  After tsdown bundling the relative path breaks
 * (`dist/logger-*.js` can no longer resolve `../config/config.js`), causing the read
 * to silently fail and the logger to fall back to the default "info" level — ignoring
 * whatever the user configured in `logging.level`.
 *
 * This version reads the JSON file directly and is bundle-safe.
 */
export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  try {
    const configPath = resolveLoggingConfigPath();
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
}
