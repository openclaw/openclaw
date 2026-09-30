import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bun = process.env.BUN_BIN ?? "bun";
const version = spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout?.trim();
const [major = 0, minor = 0] = version?.split(".").map(Number) ?? [];
const supported = major > 1 || (major === 1 && minor >= 4);

it.runIf(supported)("reuses Bun read workers and joins host and task native cleanup", async () => {
  const root = tempDirs.make("openclaw-bun-state-read-");
  const { stdout } = await promisify(execFile)(bun, [
    fileURLToPath(new URL("./openclaw-state-read-worker.bun.test-support.ts", import.meta.url)),
    root,
  ]);
  expect(stdout.trim()).toBe("Bun shared-state worker reuse and native-exit cleanup passed");
});
