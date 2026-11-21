import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

it(
  "preserves plugin artifact authoring in the native source host",
  { timeout: 180_000 },
  async () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "--import",
        pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
        "--test",
        "--experimental-test-isolation=none",
        "--test-reporter=tap",
        path.resolve("src/cli/plugins-feature-artifact.native.test-support.ts"),
      ],
      { timeout: 170_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# tests [1-9][0-9]*/);
    expect(result.stdout).toContain("# fail 0");
  },
);
