import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";

export async function localWorkspaceProjectionRoot(env?: NodeJS.ProcessEnv) {
  return path.join(await fs.realpath(resolveStateDir(env)), "worktree-projections");
}
