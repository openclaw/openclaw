import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner } from "./update-runner-types.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { entry: "standalone", budgetMs: 120_000, workMs: 6_000, corrupt: false, safe: true },
  { entry: "runner", budgetMs: 120_000, workMs: 6_000, corrupt: false, safe: true },
  { entry: "runner", budgetMs: 1_000, workMs: 6_000, corrupt: false, safe: false },
  { entry: "runner", budgetMs: 2_400_000, workMs: 1_500_000, corrupt: false, safe: true },
  { entry: "runner", budgetMs: 120_000, workMs: 6_000, corrupt: true, safe: false },
])(
  "verifies retained Git runtime after slow HEAD inspection ($entry, budget=$budgetMs, work=$workMs, corrupt=$corrupt)",
  async ({ entry, budgetMs, workMs, corrupt, safe }) => {
    const root = directories.make("git-recovery-budget-");
    const sha = "a".repeat(40);
    const dist = path.join(root, "dist");
    await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      ),
      fs.writeFile(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: sha, buildId: "retained-build" }),
      ),
      fs.writeFile(
        path.join(dist, ".buildstamp"),
        JSON.stringify({ head: corrupt ? "b".repeat(40) : sha }),
      ),
      fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
      fs.writeFile(path.join(dist, "entry.js"), "export {};\n"),
      fs.writeFile(path.join(dist, "control-ui", "index.html"), "<html></html>"),
    ]);
    vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toEqual(["git", "-C", root, "rev-parse", "HEAD"]);
      const allowance = typeof options === "number" ? options : options.timeoutMs;
      const timedOut = (allowance ?? Infinity) < workMs;
      return {
        code: timedOut ? 124 : 0,
        stdout: timedOut ? "" : `${sha}\n`,
        stderr: timedOut ? "HEAD inspection exceeded its allowance" : "",
        signal: null,
        killed: timedOut,
        cleanup: "normal",
        termination: timedOut ? "timeout" : "exit",
      };
    });
    const mutation = vi
      .fn<CommandRunner>()
      .mockRejectedValue(new Error("unexpected source mutation"));
    const recovery =
      entry === "standalone"
        ? await readCurrentGitUpdateRecovery(root)
        : (
            await updateGitCheckout({
              gitRoot: root,
              opts: { channel: "extended-stable" },
              runCommand: mutation,
              defaultCommandEnv: undefined,
              timeoutMs: budgetMs,
              startedAt: Date.now(),
            })
          ).recovery;
    expect(recovery).toEqual(
      safe
        ? { serviceRestartSafe: true, version: "2026.9.4", buildId: "retained-build" }
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    );
    expect(mutation).not.toHaveBeenCalled();
  },
);
