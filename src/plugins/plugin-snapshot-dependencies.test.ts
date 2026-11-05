import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runPluginSnapshotDependencyRegression } from "./plugin-snapshot-dependencies.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("rejects dynamic dependencies outside a managed snapshot while preserving local captures", async () => {
  await runPluginSnapshotDependencyRegression(temp.make("plugin-snapshot-closure-"));
});

it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
  "restricts Bun managed snapshot dependencies through the native loader",
  () => {
    const home = temp.make("plugin-snapshot-closure-bun-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        "src/plugins/plugin-snapshot-dependencies.test-support.ts",
        "--snapshot-dependency-regression",
        home,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
