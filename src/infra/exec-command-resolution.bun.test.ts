import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it
  .runIf(process.platform !== "win32" && process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")
  .each([true, false])(
  "preserves physical executable identity and native policy (addons=%s)",
  (addons) => {
    const home = temp.make("exec-native-policy-");
    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      [
        "--no-install",
        ...(addons ? [] : ["--no-addons"]),
        "--conditions=openclaw-custom",
        fileURLToPath(new URL("./exec-command-resolution.bun.test-support.ts", import.meta.url)),
        home,
        String(addons),
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
          OPENCLAW_STATE_DIR: home,
          FS_SAFE_NATIVE_MODE: "auto",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
