import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkDecisionTransport } from "../../scripts/bench-decision-transport-worker.ts";
import * as transportPool from "../../src/agents/provider-transport-dispatcher-pool.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("completes real registered-provider requests and drains reusable connections", async () => {
  const result = await benchmarkDecisionTransport(6);
  expect(result.requests).toBe(6);
  expect(result.connections).toBeLessThan(6);
  expect(result.socketsAfterPoolClose).toBe(0);
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
  const root = mkdtempSync(path.join(tmpdir(), "decision-transport-bench-"));
  roots.push(root);
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
    return { file, manifest };
  });
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/bench-decision-transport.mts",
        "--baseline",
        manifests[0]!.file,
        "--candidate",
        manifests[1]!.file,
        "--runs",
        "2",
        "--requests",
        "2",
        "--json",
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
  const report = JSON.parse(result.stdout);
  expect(report.samples.map((row: { variant: string }) => row.variant)).toEqual([
    "baseline",
    "candidate",
    "baseline",
    "candidate",
  ]);
  expect(report.summary.candidate.connectionsPerSample).toEqual({
    count: 2,
    min: 1,
    p50: 1,
    max: 1,
  });
  expect(report.samples[0].result.memoryAfterDrain.rss).toBe(100);
  expect(report.scope).toContain("no model inference, TLS or Gateway startup claims");
});

it.each(["workerSourceSha256", "harnessSourceSha256", "node"] as const)(
  "rejects mismatched %s before running samples",
  (field) => {
    const { manifests, run } = fixture();
    const candidate = manifests[1]!;
    candidate.manifest[field] = "f".repeat(64);
    writeFileSync(candidate.file, JSON.stringify(candidate.manifest));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("worker 1/4 start");
    expect(result.stderr.trim()).toMatch(/\[bench-decision-transport\] FAILED \(exit 1\)$/u);
    expect(result.stdout).toBe("");
  },
);

it("rejects changed build output instead of publishing a successful report", () => {
  const { manifests, run } = fixture();
  writeFileSync(path.join(path.dirname(manifests[1]!.file), "worker.mjs"), "process.exit(0);");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it("rejects an incomplete worker result even when its process succeeds", () => {
  const { run } = fixture({ warmTimingsMs: [] });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});
