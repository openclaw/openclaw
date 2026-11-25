// Admit schema maintenance before the starting Gateway opens ordinary store readers.
import fs from "node:fs";
import { createConfigIO } from "../config/io.factory.js";
import { parseConfigJson5 } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ExitError } from "../runtime.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
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
  // The ordinary Gateway guard still owns mode selection through includes.
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
    // Current-schema launcher trials publish the same explicit empty restore receipt.
    if (!(await isStateUpgradePending(env)) && env.OPENCLAW_LAUNCHER_IPC !== "1") {
      return;
    }
    // Existing offline custody checks the stopped owner read-only, then admits
    // schema work through lock.run; config-only custody cannot write databases.
    lock = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
  } catch (error) {
    throw explainMachineFailure(error, resolveStateDir(env));
  }
  try {
    const result = await lock?.run(async () => {
      if (fs.existsSync(configPath)) {
        try {
          const { configDiagnostics } = await withArtifactPreservingStateReads(() =>
            createConfigIO({
              env,
              configPath,
              observe: false,
              pluginValidation: "skip",
            }).readBestEffortConfigSnapshot(),
          );
          if (configDiagnostics !== null) {
            return {
              status: "refused",
              reason: `The config is invalid (${configDiagnostics.issues
                .slice(0, 3)
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; ")}). Run openclaw config validate before retrying the update.`,
            } as const;
          }
        } finally {
          await closeOpenClawStateDatabaseAsync();
        }
      }
      return upgradeStateDirectory({ env, log });
    });
    if (result?.status === "refused") {
      console.error(result.reason);
      throw new ExitError(78, result.reason);
    }
  } finally {
    await lock?.release();
  }
}
