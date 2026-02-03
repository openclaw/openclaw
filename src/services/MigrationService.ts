import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logWarn } from "../logger.js";

type Env = Record<string, string | undefined>;

export class MigrationService {
  private static strictModeCache: boolean | undefined;

  /**
   * Implements "Deprecation & Fallback" for Environment Variables.
   * Ensures zero breaking changes for legacy users while alerting them to migrate.
   *
   * @security STRICT MODE: If ~/.openclaw exists, we ignore legacy vars
   * unless OPENCLAW_ALLOW_LEGACY_ENV=1 is set. This prevents injection attacks.
   */
  static getEnv(key: string, env: Env = process.env): string | undefined {
    // 1. Primary: Check the new OPENCLAW_* variable
    const newKey = `OPENCLAW_${key}`;

    const value = env[newKey];
    if (value !== undefined) {
      return value;
    }

    // 2. Security Check: Should we allow legacy variables?
    const allowLegacy = env.OPENCLAW_ALLOW_LEGACY_ENV === "1";

    if (this.strictModeCache === undefined) {
      const homedir = os.homedir();
      const configDir = path.join(homedir, ".openclaw");

      // If the new config directory exists, we assume a "clean" installation
      // and default to IGNORING legacy variables to prevent injection/confusion.
      try {
        this.strictModeCache = fs.existsSync(configDir);
      } catch {
        // If we can't check the filesystem (e.g. read-only/serverless),
        // we default to loose mode (false) to ensure env fallbacks still work.
        this.strictModeCache = false;
      }
    }

    // Logic: Strict if config dir exists AND legacy not allowed.
    // We cache the filesystem check (expensive), but re-check the env var (fast).
    const strictMode = this.strictModeCache && !allowLegacy;

    if (strictMode) {
      return undefined;
    }

    // 3. Fallback: Check legacy keys (CLAWDBOT_*, MOLTBOT_*)
    const legacyKey = `CLAWDBOT_${key}`;
    const ancientKey = `MOLTBOT_${key}`;
    const fallback = env[legacyKey] ?? env[ancientKey];

    if (fallback !== undefined) {
      logWarn(
        `[SECURITY WARNING] Legacy environment variable detected: ${legacyKey}. ` +
          `Please migrate to ${newKey}. Legacy support will be removed in v2.1.0.`,
      );
    }
    return fallback;
  }
}
