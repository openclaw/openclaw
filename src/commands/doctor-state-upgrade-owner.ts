import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
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

/**
 * The stores the start imaged (or decided to migrate without an image), resolved, from its
 * own work record in this state directory; empty when no record is readable. Anything
 * Doctor finds beyond them is not covered by the start.
 */
export function readStateUpgradeCoveredStores(env: NodeJS.ProcessEnv): Set<string> {
  const stateDir = path.resolve(resolveStateDir(env));
  const prefix = `.upgrade-${resolveRuntimeServiceBuildId() ?? VERSION}-`;
  const covered = new Set<string>();
  for (const entry of fs.readdirSync(stateDir).filter((name) => name.startsWith(prefix))) {
    try {
      const text = fs.readFileSync(path.join(stateDir, entry, "inventory.json"), "utf8");
      // SAFETY: the start's state upgrade (same build) is the only writer of this record.
      for (const file of (JSON.parse(text) as { started: string[] }).started) {
        covered.add(fs.realpathSync(file));
      }
    } catch {
      // An unreadable record covers nothing.
    }
  }
  return covered;
}
