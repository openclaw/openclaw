import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isolatedCompletionWorkload,
  withUtilityBenchmarkEnvironment,
} from "../../scripts/lib/utility-benchmark-workloads.mts";

afterEach(() => vi.unstubAllEnvs());

it("gives each child fresh state without inherited credentials or selectors", () => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-parent-key");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", "parent-config.json");
  const roots: string[] = [];
  for (let sample = 0; sample < 2; sample++) {
    withUtilityBenchmarkEnvironment("isolated-completion", (env) => {
      const root = env.HOME!;
      roots.push(root);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENCLAW_CONFIG_PATH).toBe(join(root, "state/openclaw.json"));
      expect(existsSync(join(root, "workspace"))).toBe(true);
      expect(existsSync(join(root, "state/agents/main/agent"))).toBe(true);
      const child = spawnSync(
        process.execPath,
        ["-e", "console.log(process.env.OPENAI_API_KEY === undefined)"],
        {
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("true");
    });
    expect(existsSync(roots[sample]!)).toBe(false);
  }
  expect(roots[0]).not.toBe(roots[1]);
  expect(process.env.OPENAI_API_KEY).toBe("synthetic-parent-key");
  expect(process.env.OPENCLAW_CONFIG_PATH).toBe("parent-config.json");
});

it("removes process-owned state after a failed synchronous worker", () => {
  let root = "";
  expect(() =>
    withUtilityBenchmarkEnvironment("isolated-completion", (env) => {
      root = env.HOME!;
      throw new Error("worker failed");
    }),
  ).toThrow("worker failed");
  expect(existsSync(root)).toBe(false);
});

const memory = { rss: 100, heapTotal: 80, heapUsed: 40, external: 10, arrayBuffers: 5 };
const sample = {
  workload: "isolated-completion",
  requests: 2,
  connections: 1,
  moduleImportMs: 10,
  observationsMs: [4, 2],
  settledMs: [5, 3],
  dispatchMs: [1, 1],
  cpuMs: 8,
  peakRssBytes: 100,
  memoryBefore: memory,
  memoryAfter: memory,
  memoryAfterDrain: memory,
  inputTokens: 6,
  outputTokens: 2,
  cleanupFailures: 0,
  socketsAfterPoolClose: 0,
};

it("keeps cold import, logical completion and physical settlement distinct", () => {
  const parsed = isolatedCompletionWorkload.validate(sample, 2);
  const summary = isolatedCompletionWorkload.summarize([parsed, parsed]);
  expect(summary.moduleImportMs.p50).toBe(10);
  expect(summary.firstObservationMs.p50).toBe(4);
  expect(summary.firstSettledMs.p50).toBe(5);
  expect(summary.warmObservationSampleMedianMs.p50).toBe(2);
  expect(summary.warmSettledSampleMedianMs.p50).toBe(3);
  expect(summary.firstSettledMs).not.toHaveProperty("p95");
});

it.each([
  { requests: 1 },
  { connections: 0 },
  { observationsMs: [4] },
  { settledMs: [3, 3] },
  { dispatchMs: [1] },
  { moduleImportMs: Number.NaN },
  { inputTokens: 0 },
  { socketsAfterPoolClose: 1 },
  { cleanupFailures: 1 },
])("rejects incomplete or inconsistent isolated evidence: %j", (invalid) => {
  expect(() => isolatedCompletionWorkload.validate({ ...sample, ...invalid }, 2)).toThrow();
});
