import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it("rejects coverage with the default CPU sampler", () => {
  const result = spawnSync(
    resolveTestNodeExecPath(),
    ["--import", "./scripts/tsx.mjs", "scripts/bench-control-ui-cold-load.ts", "--coverage"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 45_000 },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    "coverage requires --untraced without --cpu-profile or --cpu-profile-compare",
  );
}, 60_000);
