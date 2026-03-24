import os from "node:os";
import path from "node:path";

/**
 * Resolves the OpenClaw home directory.
 * Prioritizes OPENCLAW_HOME environment variable over os.homedir().
 * Addresses #54014.
 */
export function getOpenClawHome(): string {
    const envHome = process.env.OPENCLAW_HOME;
    if (envHome) {
        return path.resolve(envHome);
    }
    return path.join(os.homedir(), ".openclaw");
}

export function resolveStateDir(): string {
    return process.env.OPENCLAW_STATE_DIR || path.join(getOpenClawHome(), "state");
}
