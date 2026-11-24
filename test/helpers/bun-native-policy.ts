import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runBunNativePolicyFixture(script: URL, home: string) {
  return spawnSync(
    process.env.BUN_BIN ?? "bun",
    ["--no-install", "--no-addons", "--conditions=openclaw-custom", fileURLToPath(script), home],
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
}
