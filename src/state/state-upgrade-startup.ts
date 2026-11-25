// Gateway startup entry for the copy-and-swap state upgrade.
import fs from "node:fs";
import path from "node:path";
import { parseConfigJson5 } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ExitError } from "../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import { isStateUpgradePending } from "./state-upgrade-databases.js";
import { explainMachineFailure, upgradeStateDirectory } from "./state-upgrade.js";

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
    // Current-schema launcher trials still need an empty restore plan. Publish
    // it through the same exclusive owner as a schema-changing swap.
    if (!(await isStateUpgradePending(env)) && env.OPENCLAW_LAUNCHER_IPC !== "1") {
      return;
    }
    // File-only ownership: the old databases are not opened for writing.
    lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  } catch (error) {
    throw explainMachineFailure(error, resolveStateDir(env));
  }
  try {
    const result = await upgradeStateDirectory({
      env,
      log,
      // Retire all candidate-local registered consumers before checkpointing and
      // linking original inodes; fresh opens must use the published generation.
      beforeSwap: () => closeOpenClawStateDatabaseAsync(),
      // The start would still refuse an invalid config after the upgrade; publish
      // nothing, so the previous package keeps reading its own state (#141451).
      // Accepted edge case: plugin-owned config is validated later, at admission,
      // because its metadata lives in the upgraded state; a rollback is a rename.
      admitConfig: async (shadow) => {
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
    if (result.status === "refused") {
      // Configuration refusal tells the resident launcher to restore the previous
      // release at once, rather than repeat a copy that cannot succeed.
      console.error(result.reason);
      throw new ExitError(78, result.reason);
    }
  } finally {
    await lock?.release();
  }
}
