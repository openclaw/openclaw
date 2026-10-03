import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { createLazyPromise, getOrCreatePromise } from "../shared/lazy-promise.js";

const gitInitializationInFlight = new Map<string, Promise<void>>();

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
  // Concurrent first turns can all observe missing Git metadata. Join only the
  // current initialization; later calls must inspect the workspace again.
  beforePersistentApply?.();
  await getOrCreatePromise(
    gitInitializationInFlight,
    dir,
    async () => {
      if (await fs.stat(path.join(dir, ".git")).catch(() => undefined)) {
        return;
      }
      if (!(await isGitAvailable())) {
        return;
      }
      // Only the initializer's owner admits Git; joining callers cannot cancel it.
      beforePersistentApply?.();
      try {
        await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
      } catch {
        // Ignore git init failures; workspace creation should still succeed.
      }
    },
    { evictOnSettled: true },
  );
}
