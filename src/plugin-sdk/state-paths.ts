import { resolveStateDir } from "../config/paths.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "../plugins/install-root-context.js";

export { resolveConfigPath, resolveOAuthDir, resolveStateDir, STATE_DIR } from "../config/paths.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";

/** Keep shared plugin resources on their operator root when runtime state is redirected. */
export function resolveManagedResourceStateDir(): string {
  return hasActivePluginInstallRoots()
    ? resolveActivePluginInstallRoots().stateDir
    : resolveStateDir();
}
