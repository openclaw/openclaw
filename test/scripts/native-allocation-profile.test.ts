import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["terminate", "natural"])(
  "removes nested census records after %s exit while preserving a live sibling",
  (mode) => {
    const output = tempDirs.make("native-profile-census-");
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "test/scripts/fixtures/native-profile-census.mjs",
        path.resolve("scripts/perf/native-allocation-profile.mjs"),
        output,
        mode,
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
