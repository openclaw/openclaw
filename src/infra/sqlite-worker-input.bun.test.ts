import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
  "transfers Bun maintenance, prepared input, commands and frames through the SQLite owner",
  () => {
    const home = temp.make("sqlite-worker-input-bun-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        "--conditions=openclaw-custom",
        fileURLToPath(new URL("./sqlite-worker-input.bun.test-support.ts", import.meta.url)),
        home,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
