// Gateway startup entry for the copy-and-swap state upgrade.
import fs from "node:fs";
import path from "node:path";
import { parseConfigJson5 } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const log = createSubsystemLogger("state/upgrade");

/**
 * Upgrade outdated state before any reader admits it, under exclusive state
 * ownership. `admits` is the Gateway start guard, asked with the raw config file;
 * a start it refuses leaves state untouched.
 */
export async function upgradeStateOnGatewayStart(
  env: NodeJS.ProcessEnv,
  admits: (start: { configExists: boolean; mode: string | undefined }) => boolean,
): Promise<void> {
  const configPath = resolveConfigPath(env, resolveStateDir(env));
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
  const parsed = raw === undefined ? undefined : parseConfigJson5(raw);
  // Accepted edge case: gateway.mode set only through $include reads as missing here,
  // so that start keeps the previous path (Doctor) instead of upgrading.
  const gateway = parsed?.ok
    ? (parsed.parsed as { gateway?: { mode?: unknown } })?.gateway
    : undefined;
  const mode = typeof gateway?.mode === "string" ? gateway.mode : undefined;
  if (!admits({ configExists: raw !== undefined, mode })) {
    return;
  }
  // File-only ownership: the old databases are not opened for writing.
  const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  try {
    const statePath = path.join(resolveStateDir(env), "state", "openclaw.sqlite");
    await upgradeStateDirectory({
      env,
      log,
      // Selecting the environment read the config, which can leave a worker on a
      // current shared database; it must reopen the swapped file, not the old one.
      beforeSwap: async () => {
        await closeOpenClawStateDatabaseByPathAsync(statePath);
      },
    });
  } finally {
    await lock?.release();
  }
}
