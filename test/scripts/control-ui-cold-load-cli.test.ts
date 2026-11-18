import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it.each([
  [
    "scripts/bench-control-ui-cold-load.ts",
    ["--coverage"],
    "coverage requires --untraced without --cpu-profile or --cpu-profile-compare",
  ],
  [
    "scripts/perf/warm-reload-proof.ts",
    ["--prime-reloads=-1"],
    "--prime-reloads must be an integer in [0, 10]",
  ],
  [
    "scripts/bench-control-ui-cold-load.ts",
    ["--prime-reloads=-1"],
    "prime-reloads must be an integer from 0 to 10",
  ],
])(
  "rejects invalid capture setup in %s (%j)",
  (script, args, message) => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["--import", "./scripts/tsx.mjs", script, ...args],
      { cwd: process.cwd(), encoding: "utf8", timeout: 45_000 },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(message);
  },
  60_000,
);
