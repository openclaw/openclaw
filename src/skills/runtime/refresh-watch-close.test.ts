import { FSWatcher } from "chokidar";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("keeps retirement terminal while a replacement watcher admits the root", async () => {
  const root = roots.make("skills-retired-watcher-");
  const retired = new FSWatcher({ ignoreInitial: true });
  const replacement = new FSWatcher({ ignoreInitial: true });
  try {
    await teardownSkillsPathWatcher({ watcher: retired });
    // Removed-directory recovery resumes through this same public admission path.
    retired.add(root);
    expect(retired.closed).toBe(true);

    const ready = new Promise<void>((resolve, reject) => {
      replacement.once("ready", resolve);
      replacement.once("error", reject);
    });
    replacement.add(root);
    await ready;
    expect(replacement.closed).toBe(false);
    expect(Object.keys(replacement.getWatched())).toContain(root);
  } finally {
    await Promise.all([retired.close(), replacement.close()]);
  }
});
