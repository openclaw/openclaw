// Gateway startup entry for the in-place state upgrade.
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
  StateUpgradeCustodyLostError,
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
    const acquire = () => acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
    await upgradeStateDirectory({
      env,
      log,
      // The in-place Doctor takes this state's maintenance custody itself; hand it over
      // and take it back before anything else here touches the state.
      handOffCustody: async (run) => {
        await closeOpenClawStateDatabaseByPathAsync(statePath);
        await lock?.release();
        lock = null;
        try {
          return await run();
        } finally {
          lock = await acquire().catch((error: unknown) => {
            throw new StateUpgradeCustodyLostError(
              "Another OpenClaw process took state ownership during the upgrade; this start stops and leaves the upgrade to it.",
              { cause: error },
            );
          });
        }
      },
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
        // The live config and state, migrated in place.
        if (!fs.existsSync(shadow.configPath)) {
          return undefined;
        }
        const { createConfigIO } = await import("../config/io.factory.js");
        try {
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
        } finally {
          // Provider defaults can open metadata readers even when plugin validation is skipped.
          // Drain them before the shadow is renamed or removed; SQLite retains its original path.
          await closeOpenClawStateDatabaseByPathAsync(
            path.join(shadow.stateDir, "state", "openclaw.sqlite"),
          );
        }
      },
    });
  } finally {
    await lock?.release();
  }
}
