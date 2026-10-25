import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkDecisionTransport } from "../../scripts/bench-decision-transport-worker.ts";
import * as transportPool from "../../src/agents/provider-transport-dispatcher-pool.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("completes real registered-provider requests and drains reusable connections", async () => {
  const result = await benchmarkDecisionTransport(6);
  expect(result).toMatchObject({ requests: 6, socketsAfterPoolClose: 0 });
  expect(result.connections).toBeLessThan(6);
  expect(result.warmTimingsMs).toHaveLength(5);
});

it("fails teardown when the client pool leaves its reusable connection open", async () => {
  const close = vi.spyOn(transportPool, "closeProviderTransportDispatcherPool").mockResolvedValue();
  try {
    await expect(benchmarkDecisionTransport(2)).rejects.toThrow("Transport pool teardown exceeded");
  } finally {
    close.mockRestore();
    await transportPool.closeProviderTransportDispatcherPool();
  }
});

function fixture(candidateResult: Record<string, unknown> = {}) {
  const root = roots.make("decision-transport-bench-");
  const memory = { rss: 100, heapTotal: 80, heapUsed: 40, external: 10, arrayBuffers: 5 };
  const result = {
    requests: 2,
    connections: 1,
    responseBytes: 200,
    firstEvaluationMs: 2,
    warmTimingsMs: [1],
    cpuMs: 1,
    peakRssBytes: 100,
    memoryBefore: memory,
    memoryAfter: memory,
    memoryAfterDrain: memory,
    idleSocketsBeforeTeardown: 1,
    socketsAfterPoolClose: 0,
  };
  const manifests = ["baseline", "candidate"].map((side) => {
    const directory = path.join(root, side);
    mkdirSync(directory);
    const output = side === "candidate" ? { ...result, ...candidateResult } : result;
    const source = `console.log(${JSON.stringify(`[bench-decision-transport-result] ${JSON.stringify(output)}`)});`;
    writeFileSync(path.join(directory, "worker.mjs"), source);
    const manifest = {
      sourceRevision: (side === "baseline" ? "a" : "b").repeat(40),
      node: process.version,
      entry: "worker.mjs",
      lockfileSha256: "c".repeat(64),
      workerSourceSha256: "d".repeat(64),
      harnessSourceSha256: "e".repeat(64),
      outputs: [{ file: "worker.mjs", sha256: createHash("sha256").update(source).digest("hex") }],
    };
    const file = path.join(directory, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    return { file, manifest, flag: `--${side}` };
  });
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/bench-decision-transport.mts",
        ...manifests.flatMap(({ flag, file }) => [flag, file]),
        ..."--runs 2 --requests 2 --json".split(" "),
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
  return { manifests, run };
}

it("runs serial ABAB samples and reports bounded evidence without unsupported tail percentiles", () => {
  const { run } = fixture();
  const result = run();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const { samples, summary, scope } = JSON.parse(result.stdout);
  const order = samples.map((row: { variant: string }) => row.variant);
  expect(order).toEqual(["baseline", "candidate", "baseline", "candidate"]);
  expect(summary.candidate.connectionsPerSample).toEqual({ count: 2, min: 1, p50: 1, max: 1 });
  expect(samples[0].result.memoryAfterDrain.rss).toBe(100);
  expect(scope).toContain("no model inference, TLS or Gateway startup claims");
});

it.each(["workerSourceSha256", "harnessSourceSha256", "node", "artifact", "result"] as const)(
  "rejects invalid %s without publishing a report",
  (field) => {
    const { manifests, run } = fixture(field === "result" ? { warmTimingsMs: [] } : {});
    const candidate = manifests[1]!;
    if (field === "artifact") {
      writeFileSync(path.join(path.dirname(candidate.file), "worker.mjs"), "process.exit(0);");
    } else if (field !== "result") {
      candidate.manifest[field] = "f".repeat(64);
      writeFileSync(candidate.file, JSON.stringify(candidate.manifest));
    }
    const result = run();
    expect(result).toMatchObject({ status: 1, stdout: "" });
    if (field !== "result") {
      expect(result.stderr).not.toContain("worker 1/4 start");
    }
  },
);
