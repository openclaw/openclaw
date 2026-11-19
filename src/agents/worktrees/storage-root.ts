import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export function resolveManagedWorktreeRoot(
  env: NodeJS.ProcessEnv,
  configuredRoot?: string,
): string {
  return configuredRoot ?? path.join(resolveStateDir(env), "worktrees");
}
