import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { createLazyPromise } from "../shared/lazy-promise.js";

// Git availability is process-stable; cache the probe result, including failure, until restart.
const isGitAvailable = createLazyPromise(async () => {
  try {
    const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
    return result.code === 0;
  } catch {
    return false;
  }
});

export async function ensureGitRepo(
  dir: string,
  isBrandNewWorkspace: boolean,
  beforePersistentApply?: () => void,
) {
  if (!isBrandNewWorkspace) {
    return;
  }
  beforePersistentApply?.();
  if (await fs.stat(path.join(dir, ".git")).catch(() => undefined)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  beforePersistentApply?.();
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}
