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
