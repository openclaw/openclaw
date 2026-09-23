import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
  "reloads Bun plugin generations while retained callers keep their original modules",
  () => {
    const home = temp.make("plugin-bun-generations-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        "--conditions=openclaw-custom",
        "src/plugins/plugin-module-generation.bun.test-support.ts",
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
