import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { benchSessionHistoryEntrypoint } from "../../scripts/bench-session-history-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it("drains seeded transcript owners before fresh-process history measurements", () => {
  const benchmarkUrl = resolveRuntimeWorkerUrl(benchSessionHistoryEntrypoint);
  expect(benchmarkUrl.pathname).toMatch(/\.js$/u);
  const execPath = resolveTestNodeExecPath();
  const result = spawnSync(
    execPath,
    [
      ...resolveRuntimeWorkerArgv(benchmarkUrl, execPath),
      "--profile",
      "small,long",
      "--operation",
      "recent",
      "--samples",
      "1",
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report: unknown = JSON.parse(result.stdout);
  expect(report).toEqual(
    expect.objectContaining({
      results: [
        expect.objectContaining({
          profile: "small",
          operation: "recent",
          result: { returned: 20, total: 80 },
        }),
        expect.objectContaining({
          profile: "long",
          operation: "recent",
          result: { returned: 20, total: 10_000 },
        }),
      ],
    }),
  );
}, 35_000);

it("keeps the source benchmark JSON parseable across all history readers", () => {
  // Keep the documented source CLI: compiled coverage misses its startup/shutdown boundary.
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/bench-session-history.ts",
      "--profile",
      "small",
      "--samples",
      "1",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      // Exercise diagnostic routing rather than Vitest's default silent console.
      env: { ...process.env, OPENCLAW_LOG_LEVEL: "info", TSX_DISABLE_CACHE: "1" },
      timeout: 60_000,
    },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report: unknown = JSON.parse(result.stdout);
  expect(report).toEqual(
    expect.objectContaining({
      results: ["recent", "page", "gateway-tail"].map((operation) =>
        expect.objectContaining({
          profile: "small",
          operation,
          result: { returned: 20, total: 80 },
        }),
      ),
    }),
  );
}, 65_000);
