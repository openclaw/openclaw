import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("benchmarks current and pre-agent-core completion owners through the CLI", () => {
  const legacy = tempDirs.make("completion-benchmark-baseline-");
  const ownerPath = "src/agents/tool-source-reply-completion.ts";
  mkdirSync(path.join(legacy, "src/agents"), { recursive: true });
  writeFileSync(
    path.join(legacy, ownerPath),
    readFileSync(ownerPath, "utf8").replace(
      "../../packages/agent-core/src/internal-hooks.js",
      "./runtime/internal-hooks.js",
    ),
  );
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--expose-gc",
      "scripts/perf/tool-source-reply-completion-measure.mjs",
      legacy,
      process.cwd(),
      "1",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0]).toMatchObject({ protocol: "tool-source-reply-completion-v1", pairs: 5 });
  const measurements = rows.filter((row) => row.side);
  expect(measurements).toHaveLength(20);
  for (const row of measurements) {
    expect(row).toMatchObject({ calls: 1, cells: 64, completions: 5 });
  }
});
