import path from "node:path";
import { resolveConfigPath, resolveIncludeRoots, resolveStateDir } from "../../../config/paths.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "../../../infra/update-rehearsal-paths.js";
import { resolveActivePluginInstallRoots } from "../../../plugins/install-root-context.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";

/** Keep private Doctor writes bound to the original child contract, not a derived convergence env. */
export function createDoctorRehearsalWriteGuard(
  env: NodeJS.ProcessEnv,
): ((destination?: string) => void) | undefined {
  const root = resolveUpdateRehearsalRoot(env);
  if (!root) {
    return undefined;
  }
  return (destination) => {
    if (
      resolveUpdateRehearsalRoot(env) !== root ||
      resolveUpdateRehearsalRoot(process.env) !== root
    ) {
      throw new Error("Update rehearsal authority changed before Doctor repair");
    }
    const paths = [
      destination,
      resolveStateDir(env),
      resolveOpenClawStateSqlitePath(env),
      resolveConfigPath(env),
      ...resolveIncludeRoots(env),
      ...Object.values(resolveActivePluginInstallRoots(env)),
      env.XDG_CACHE_HOME,
      path.join(root, "cache", "npm"),
    ];
    for (const writePath of paths) {
      if (writePath && isUpdateRehearsalReadOnlyPath(writePath, env)) {
        throw new Error(`Doctor repair destination escapes the update rehearsal: ${writePath}`);
      }
    }
  };
}
