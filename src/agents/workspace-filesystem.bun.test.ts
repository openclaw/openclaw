import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
  "preserves native policy across workspace publication and cleanup in a reused worker",
  () => {
    const root = temp.make("workspace-native-policy-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        "--no-addons",
        "--conditions=openclaw-custom",
        fileURLToPath(
          new URL("./workspace-filesystem.native-policy.test-support.ts", import.meta.url),
        ),
        root,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TMPDIR: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          FS_SAFE_NATIVE_MODE: "auto",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
