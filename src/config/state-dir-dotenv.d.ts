import type { OpenClawConfig } from "./types.js";
export declare function readStateDirDotEnvVarsFromStateDir(stateDir: string): Record<string, string>;
/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for embedding in a service
 * environment (LaunchAgent plist, systemd unit, Scheduled Task).
 */
export declare function readStateDirDotEnvVars(env: Record<string, string | undefined>): Record<string, string>;
/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into gateway install metadata.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export declare function collectDurableServiceEnvVars(params: {
    env: Record<string, string | undefined>;
    config?: OpenClawConfig;
}): Record<string, string>;
