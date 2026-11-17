// Gateway startup entry for the copy-and-swap state upgrade.
import fs from "node:fs";
import path from "node:path";
import { parseConfigJson5 } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import {
  explainMachineFailure,
  isStateUpgradePending,
  upgradeStateDirectory,
} from "./state-upgrade.js";

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
  const root: unknown = parsed?.ok ? parsed.parsed : undefined;
  const gateway = root && typeof root === "object" && "gateway" in root ? root.gateway : undefined;
  const modeValue =
    gateway && typeof gateway === "object" && "mode" in gateway ? gateway.mode : undefined;
  const mode = typeof modeValue === "string" ? modeValue : undefined;
  if (!admits({ configExists: raw !== undefined, mode })) {
    return;
  }
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    // A read-only open on a full disk fails too (it cannot create the shared-memory file).
    if (!isStateUpgradePending(env)) {
      return;
    }
    // File-only ownership: the old databases are not opened for writing.
    lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  } catch (error) {
    throw explainMachineFailure(error, resolveStateDir(env));
  }
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
      // The start would still refuse an invalid config after the upgrade; publish
      // nothing, so the previous package keeps reading its own state (#141451).
      // Accepted edge case: plugin-owned config is validated later, at admission,
      // because its metadata lives in the upgraded state; a rollback is a rename.
      admitConfig: async (shadow) => {
        if (!fs.existsSync(shadow.configPath)) {
          return undefined;
        }
        const { createConfigIO } = await import("../config/io.factory.js");
        const { configDiagnostics } = await createConfigIO({
          env: {
            ...env,
            OPENCLAW_STATE_DIR: shadow.stateDir,
            OPENCLAW_CONFIG_PATH: shadow.configPath,
          },
          configPath: shadow.configPath,
          observe: false,
          pluginValidation: "skip",
        }).readBestEffortConfigSnapshot();
        return configDiagnostics === null
          ? undefined
          : `the upgraded config is invalid (${configDiagnostics.issues
              .slice(0, 3)
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")})`;
      },
    });
  } finally {
    await lock?.release();
  }
}
