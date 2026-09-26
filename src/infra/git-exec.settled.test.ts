import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { removeManagedCheckout } from "../agents/worktrees/removal-git.js";
import * as commandExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GIT_TIMEOUT_MS } from "./git-exec.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("joins an admitted destructive child beyond the ordinary Git deadline", async () => {
  const directory = dirs.make("openclaw-settled-git-");
  const release = path.join(directory, "release");
  const ready = createDeferredCore();
  const run = commandExec.runCommandWithTimeout;
  vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (_argv, options) =>
    run(
      [
        process.execPath,
        "-e",
        `
        const fs = require('node:fs');
        const dir = process.argv[1];
        const watcher = fs.watch(dir, () => {
          if (fs.existsSync(dir + '/release')) watcher.close();
        });
        process.stdout.write('ready\\n');
      `,
        directory,
      ],
      {
        ...(typeof options === "number" ? { timeoutMs: options } : options),
        onOutputChunk: () => {
          ready.resolve();
        },
      },
    ),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const removal = withWorktreeGitConfig(directory, false, {}, (git) =>
    removeManagedCheckout(
      {
        id: "fixture",
        name: "fixture",
        repoRoot: directory,
        repoFingerprint: "fixture",
        path: path.join(directory, "fixture"),
        branch: "openclaw/fixture",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      },
      git,
      true,
    ),
  );
  try {
    await Promise.race([
      ready.promise,
      removal.then(() => {
        throw new Error("child exited before admission");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(GIT_TIMEOUT_MS + 1_000);
    await fs.writeFile(release, "settle");
    await expect(removal).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
    await fs.writeFile(release, "settle");
    await removal;
  }
});
