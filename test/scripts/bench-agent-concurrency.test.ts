import { expect, it } from "vitest";
import { testing as workerTesting } from "../../scripts/bench-agent-concurrency-worker.ts";
import {
  testing,
  WORKER_RESULT_SENTINEL,
  type WorkerResult,
  type WorkerScenario,
} from "../../scripts/bench-agent-concurrency.ts";
import { createGatewayActiveWorkSnapshot } from "../../src/infra/gateway-active-work.js";
import {
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../src/process/gateway-work-admission.js";
import { createDeferred } from "../helpers/promise.js";

function workerResult(scenario: WorkerScenario, size: number, timingsMs = [1, 2, 3]): WorkerResult {
  return {
    scenario,
    size,
    timingsMs,
    memory: { rssStartBytes: 100, rssEndBytes: 120, processMaxRssBytes: 150 },
    invariant:
      scenario === "admission"
        ? { ok: true, admissionCap: size, overflowRejected: true, released: true }
        : { ok: true },
  };
}

function workerStdout(result: WorkerResult): string {
  return `${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`;
}

it("parses bounded options and rejects ambiguous arguments", () => {
  const args = "--runs 2 --warmup 0 --fanout 1,4 --sweep-rows 8,16 --output bench.json --json";
  expect(testing.parseOptions(args.split(" "))).toMatchObject({
    runs: 2,
    warmup: 0,
    fanout: [1, 4],
    sweepRows: [8, 16],
    output: "bench.json",
    json: true,
  });
  for (const [invalid, error] of [
    ["--runs 101", "--runs must be at most 100"],
    ["--fanout 1,1", "--fanout contains duplicate values"],
    ["--runs 1 --runs 2", "--runs was provided more than once"],
    ["--wat", "Unknown argument: --wat"],
  ] as const) {
    expect(() => testing.parseOptions(invalid.split(" "))).toThrow(error);
  }
});

it("emits supported tail percentiles", () => {
  const summary = testing.summarizeTimings(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(summary).toMatchObject({ count: 20, p50: 10, p95: 19, p99: 20, max: 20 });
});

it("drains detached gateway active work before the next spawn sample", async () => {
  resetGatewayWorkAdmission();
  const deferred = createDeferred();
  const rootWork = runWithGatewayIndependentRootWorkAdmission(() => deferred.promise);
  try {
    expect(createGatewayActiveWorkSnapshot().counts.rootRequests).toBe(1);
    const drain = workerTesting.drainSpawnSampleActiveWork();
    await expect(
      Promise.race([
        drain.then(() => "drained"),
        new Promise<string>((resolve) => {
          setImmediate(() => resolve("pending"));
        }),
      ]),
    ).resolves.toBe("pending");

    deferred.resolve();
    await expect(drain).resolves.toBe(0);
  } finally {
    deferred.resolve();
    await rootWork;
    resetGatewayWorkAdmission();
  }
});

it("rejects a spawn sample when detached gateway active work does not drain", async () => {
  await expect(
    workerTesting.drainSpawnSampleActiveWork(async (timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      return { drained: false, snapshot: { counts: { totalActive: 2 } } };
    }),
  ).rejects.toThrow("spawn sample left 2 active gateway work items");
});

it("aggregates each concurrency scenario", () => {
  const options = testing.parseOptions("--runs 3 --warmup 0 --fanout 2 --sweep-rows 4".split(" "));
  const report = testing.benchmark(options, {
    runWorker: (_options, scenario, size) => workerResult(scenario, size),
    writeProgress: () => {},
  });

  expect(report.invariants.ok).toBe(true);
  expect(report.scenarios.admission[0]).toMatchObject({
    size: 2,
    timingsMs: { count: 3, p50: 2 },
    invariant: { admissionCap: 2 },
  });
});

it("rejects incomplete synthetic worker sets", () => {
  const options = testing.parseOptions(["--fanout", "1", "--sweep-rows", "1"]);
  expect(() =>
    testing.aggregateWorkerResults(options, [workerResult("spawnPipelineInMemory", 1)]),
  ).toThrow("worker result mismatch");
});

it("rejects malformed, duplicate, mismatched, partial, and timed-out worker results", () => {
  const expected = { scenario: "admission" as const, size: 2, runs: 3 };
  const valid = workerResult("admission", 2);
  const parse = (overrides: Partial<Parameters<typeof testing.parseWorkerProcessResult>[0]>) =>
    testing.parseWorkerProcessResult(
      { status: 0, stdout: workerStdout(valid), stderr: "", ...overrides },
      expected,
    );
  expect(parse({})).toEqual(valid);

  const missingInvariant = structuredClone(valid);
  delete missingInvariant.invariant.admissionCap;
  const invalidPayloads = [
    [`${WORKER_RESULT_SENTINEL}{\n`, "returned invalid JSON"],
    [`${workerStdout(valid)}${workerStdout(valid)}`, "returned 2 result payloads"],
    [workerStdout(workerResult("admission", 3)), "mismatched identity"],
    [
      `${WORKER_RESULT_SENTINEL}${JSON.stringify({ ...valid, memory: {} })}\n`,
      "memory.rssStartBytes",
    ],
    [workerStdout({ ...valid, timingsMs: [1, 2] }), "returned 2 samples; expected 3"],
    [workerStdout(missingInvariant), "invariant.admissionCap is missing or invalid"],
  ] as const;
  for (const [stdout, error] of invalidPayloads) {
    expect(() => parse({ stdout })).toThrow(error);
  }
  expect(() => parse({ status: 7, stdout: "", stderr: "worker exploded" })).toThrow(
    "failed (7): worker exploded",
  );
  expect(() =>
    parse({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
    }),
  ).toThrow("timed out after 300000ms");
});
