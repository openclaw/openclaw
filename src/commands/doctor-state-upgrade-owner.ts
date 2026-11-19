import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { DoctorOptions } from "./doctor.types.js";

/**
 * Gateway start's in-place state upgrade runs Doctor on the live state and names
 * that directory as its own. That caller already took (or, without room, skipped)
 * the one pre-migration image of each outdated database, so Doctor takes no
 * original-state capture and no migration backup set of its own in this run.
 */
export function isStateUpgradeImageOwner(
  options: Pick<DoctorOptions, "stateUpgradeLiveStateDir">,
  env: NodeJS.ProcessEnv,
): boolean {
  const live = options.stateUpgradeLiveStateDir;
  return live !== undefined && path.resolve(live) === path.resolve(resolveStateDir(env));
}
