// Gateway concurrency benchmark tests cover CLI controls, probe budgets, and summaries.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createRawServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/bench-gateway-concurrency.ts";
import {
  controlGatewayHeapProfile,
  readGatewayHeapProfile,
} from "../../scripts/lib/gateway-bench-heap.ts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { createDeferred } from "../helpers/promise.js";

type BenchmarkRun = Parameters<typeof testing.summarizeRuns>[0][number];

function createBenchmarkRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    controlPlane: [],
    controlUi: [],
    durationMs: 10,
    freshConnection: { error: null, latencyMs: 25, ok: true },
    history: [],
    memory: {
      after: { atMs: 10, heapTotalMb: 120, heapUsedMb: 80, rssMb: 200 },
      before: { atMs: 0, heapTotalMb: 100, heapUsedMb: 60, rssMb: 180 },
      peakRssMb: 210,
    },
    messageSubscriptions: [],
    messageSubscriptionsDuringLoad: [],
    modelRequestCount: 1,
    probeWarmup: { durationMs: 2, samples: [] },
    pluginMetadataScans: { count: 0, durationMs: null, totalDurationMs: 0 },
    readyz: [],
    sessionSeedDurationMs: 2,
    sessionsList: [],
    sessionUpdates: [],
    setupDurationMs: 3,
    turnCount: 8,
    turnsDurationMs: 5,
    ...overrides,
  };
}

describe("gateway concurrency benchmark script", () => {
  it("profiles load allocations after collection without charging startup allocations", async () => {
    await withTempDir("gateway-heap-profile-", async (dir) => {
      const child = spawn(
        process.execPath,
        [
          "--expose-gc",
          "--import",
          new URL("../../scripts/lib/gateway-bench-heap-preload.ts", import.meta.url).href,
          "--input-type=module",
          "--eval",
          `process.stdin.resume();
        function startupAllocations() {
          return Array.from({ length: 20000 }, (_, index) => Array(100).fill(index));
        }
        globalThis.startup = startupAllocations();
        globalThis.startup = null;
        gc();
        function loadAllocations() {
          return Array.from({ length: 20000 }, (_, index) => Array(100).fill(index));
        }
        process.on("message", (message) => {
          if (message !== "allocate") return;
          globalThis.load = loadAllocations();
          globalThis.load = null;
          gc();
          gc();
          process.send("allocated");
        });
        process.send("ready");`,
        ],
        { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      );
      const exited = once(child, "exit");
      try {
        const ready = await Promise.race([
          once(child, "message"),
          exited.then(() => {
            throw new Error("Heap profile fixture exited before ready");
          }),
        ]);
        expect(ready[0]).toBe("ready");
        const profilePath = `${dir}/load.heapprofile`;
        await controlGatewayHeapProfile(child, "start", profilePath);
        const allocated = once(child, "message");
        child.send("allocate");
        expect((await allocated)[0]).toBe("allocated");
        await controlGatewayHeapProfile(child, "stop", profilePath);
        const profile = readGatewayHeapProfile(profilePath);
        expect(profile.sampledAllocatedBytes).toBeGreaterThan(1_000_000);
        const stacks = profile.topAllocationSites.flatMap((site) => site.stack).join("\n");
        expect(stacks).toContain("loadAllocations");
        expect(stacks).not.toContain("startupAllocations");
      } finally {
        child.kill();
        await exited;
      }
    });
  });

  it("parses benchmark controls without booting a gateway", () => {
    expect(
      testing.parseOptions([
        "--concurrency",
        "12",
        "--turns-per-session",
        "8",
        "--runs",
        "2",
        "--warmup",
        "0",
        "--cadence-ms",
        "50",
        "--timeout-ms",
        "90000",
        "--cpu-prof-dir",
        "/tmp/gateway-cpu-profiles",
        "--heap-prof-dir",
        "/tmp/gateway-heap-profiles",
        "--plugin-count",
        "50",
        "--probe-rounds",
        "20",
        "--session-count",
        "120",
        "--control-plane",
        "--history-messages",
        "20",
        "--history-message-chars",
        "8192",
        "--history-clients",
        "6",
        "--history-burst",
        "5",
        "--session-updates",
        "500",
        "--session-update-clients",
        "8",
        "--subscribers",
        "4",
        "--stream-chunk-delay-ms",
        "2000",
        "--max-control-ms",
        "2000",
        "--max-handshake-ms",
        "2000",
        "--tool-events",
        "--no-diagnostics-timeline",
        "--visible-observer",
        "--workspace-fanout",
        "--output",
        "concurrency.json",
        "--json",
      ]),
    ).toMatchObject({
      cadenceMs: 50,
      concurrency: 12,
      cpuProfDir: "/tmp/gateway-cpu-profiles",
      heapProfDir: "/tmp/gateway-heap-profiles",
      diagnosticsTimeline: false,
      json: true,
      historyBurst: 5,
      historyClients: 6,
      historyMessages: 20,
      historyMessageChars: 8192,
      controlPlane: true,
      maxControlMs: 2_000,
      maxHandshakeMs: 2_000,
      output: "concurrency.json",
      pluginCount: 50,
      probeRounds: 20,
      runs: 2,
      sessionCount: 120,
      sessionUpdateClients: 8,
      sessionUpdates: 500,
      streamChunkDelayMs: 2_000,
      subscribers: 4,
      timeoutMs: 90_000,
      toolEvents: true,
      turnsPerSession: 8,
      visibleObserver: true,
      warmup: 0,
      workspaceFanout: true,
    });
    expect(() => testing.parseOptions(["--concurrency", "65"])).toThrow(
      "--concurrency must be at most 64",
    );
    expect(testing.parseOptions([]).turnsPerSession).toBe(1);
    expect(() => testing.parseOptions(["--turns-per-session", "0"])).toThrow("--turns-per-session");
    expect(() => testing.parseOptions(["--turns-per-session", "101"])).toThrow(
      "--turns-per-session must be at most 100",
    );
    expect(() => testing.parseOptions(["--runs", "2", "--runs", "3"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
    expect(() => testing.parseOptions(["--plugin-count", "101"])).toThrow(
      "--plugin-count must be at most 100",
    );
    expect(testing.parseOptions(["--session-count", "10000"]).sessionCount).toBe(10_000);
    expect(() => testing.parseOptions(["--session-count", "10001"])).toThrow(
      "--session-count must be at most 10000",
    );
    expect(() => testing.parseOptions(["--history-burst", "33"])).toThrow(
      "--history-burst must be at most 32",
    );
    expect(() => testing.parseOptions(["--session-updates", "100001"])).toThrow(
      "--session-updates must be at most 100000",
    );
    expect(testing.parseOptions([]).diagnosticsTimeline).toBe(true);
    expect(testing.parseOptions([]).probeRounds).toBeUndefined();
    expect(() => testing.parseOptions(["--probe-rounds", "0"])).toThrow();
    expect(() => testing.parseOptions(["--probe-rounds", "2049"])).toThrow(
      "--probe-rounds must be at most 2048",
    );
    expect(() =>
      testing.parseOptions([
        "--probe-rounds",
        "205",
        "--history-clients",
        "2",
        "--history-burst",
        "5",
      ]),
    ).toThrow("fixed history workload must not exceed 2048 requests per run");
    expect(() =>
      testing.parseOptions(["--session-count", "10000", "--history-messages", "500"]),
    ).toThrow("synthetic history");
    expect(() =>
      testing.parseOptions([
        "--session-count",
        "1000",
        "--history-messages",
        "10",
        "--history-message-chars",
        "65536",
      ]),
    ).toThrow("synthetic history");
  });

  it("summarizes plugin metadata scans captured after startup warmup", () => {
    expect(
      testing.summarizePluginMetadataScans([
        { durationMs: 18, name: "plugins.metadata.scan" },
        { durationMs: 22, name: "plugins.metadata.scan" },
        { durationMs: 9, name: "plugins.metadata.freeze" },
      ]),
    ).toEqual({
      count: 2,
      durationMs: { count: 2, max: 22, p50: 18, p95: 22, p99: 22 },
      totalDurationMs: 40,
    });
  });

  it("does not report missing or incomplete timeline evidence as zero scans", async () => {
    await withTempDir("openclaw-concurrency-timeline-", async (root) => {
      const file = `${root}/timeline.jsonl`;
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
      await writeFile(file, "");
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
      await writeFile(file, '{"type":"span.end","name":"plugins.metadata.scan"');
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
    });
  });

  it("counts load spans by emission time even when buffered setup spans arrive later", async () => {
    await withTempDir("openclaw-concurrency-timeline-", async (root) => {
      const file = `${root}/timeline.jsonl`;
      const spans = [999, 1_000, 1_500, 2_000, 2_001].map((timestamp) => ({
        schemaVersion: "openclaw.diagnostics.v1",
        type: "span.end",
        name: "plugins.metadata.scan",
        durationMs: 10,
        timestamp: new Date(timestamp).toISOString(),
      }));
      await writeFile(file, spans.map((span) => JSON.stringify(span)).join("\n") + "\n");

      expect(
        testing.summarizePluginMetadataScans(
          testing.readDiagnosticsTimelineSpans(file, { from: 1_000, through: 2_000 }),
        ),
      ).toMatchObject({ count: 3, totalDurationMs: 30 });
      await writeFile(file, JSON.stringify({ ...spans[0], timestamp: "invalid" }) + "\n");
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow("invalid diagnostics");
    });
  });

  it("aggregates plugin metadata scans across measured runs", () => {
    const createRun = (count: number, durations: number[]) =>
      createBenchmarkRun({
        pluginMetadataScans: {
          count,
          durationMs: testing.summarizeNumbers(durations),
          totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
        },
      });

    expect(testing.summarizeRuns([createRun(2, [10, 20]), createRun(1, [30])])).toMatchObject({
      gatewayHeapGrowthMb: { count: 2, max: 20, p50: 20, p95: 20, p99: 20 },
      gatewayPeakRssMb: { count: 2, max: 210, p50: 210, p95: 210, p99: 210 },
      gatewayRssGrowthMb: { count: 2, max: 20, p50: 20, p95: 20, p99: 20 },
      modelRequestCount: 2,
      pluginMetadataScanCount: 3,
      pluginMetadataScanTotalDurationMs: 60,
    });
  });

  it("reports p50, p95, p99, and max with nearest-rank percentiles", () => {
    expect(testing.summarizeNumbers([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      max: 100,
      p50: 3,
      p95: 100,
      p99: 100,
    });
    expect(testing.summarizeNumbers([])).toBeNull();
  });

  it.each([
    ["readyz", "readyz"],
    ["controlUi", "Control UI"],
    ["sessionsList", "sessions.list"],
    ["history", "chat.history"],
    ["messageSubscriptionsDuringLoad", "sessions.messages.subscribe"],
    ["sessionUpdates", "sessions.patch"],
  ] as const)("enforces the control budget for measured %s probes", (field, name) => {
    const options = testing.parseOptions(["--max-control-ms", "2000"]);
    const probe: BenchmarkRun["readyz"][number] = {
      atMs: 0,
      cpuCoreRatio: null,
      degraded: null,
      degradedSinceMs: null,
      delayP99Ms: null,
      delayMaxMs: null,
      error: null,
      latencyMs: 2_000,
      ok: true,
      status: 200,
      utilization: null,
    };
    const run = createBenchmarkRun({ [field]: [probe] });
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);

    probe.latencyMs = 2_576;
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      `Gateway ${name} probe exceeded 2000ms: ok=true latencyMs=2576.0 error=none`,
    ]);

    probe.latencyMs = 10;
    probe.ok = false;
    probe.error = "request failed";
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      `Gateway ${name} probe exceeded 2000ms: ok=false latencyMs=10.0 error=request failed`,
    ]);
    expect(testing.summarizeRuns([run]).budgetViolations).toEqual([]);
  });

  it.each(["tasks.list", "cron.list", "cron.status"])(
    "enforces the control budget for %s",
    (method) => {
      const run = createBenchmarkRun({
        controlPlane: [
          {
            method,
            atMs: 0,
            error: null,
            latencyMs: 2001,
            ok: true,
          },
        ],
      });
      const summary = testing.summarizeRuns([run], { maxControlMs: 2000 });
      expect(summary.budgetViolations).toEqual([
        `Gateway ${method} probe exceeded 2000ms: ok=true latencyMs=2001.0 error=none`,
      ]);
      expect(summary.controlPlane[method]).toMatchObject({
        failedSamples: 0,
        latencyMs: { count: 1, max: 2001 },
      });
    },
  );

  it("keeps setup probes outside the control budget and handshakes under their own budget", () => {
    const slowProbe = { atMs: 0, error: null, latencyMs: 5_000, ok: true };
    const slowReady = {
      ...slowProbe,
      cpuCoreRatio: null,
      degraded: null,
      degradedSinceMs: null,
      delayP99Ms: null,
      delayMaxMs: null,
      status: 200,
      utilization: null,
    };
    const run = createBenchmarkRun({
      freshConnection: slowProbe,
      messageSubscriptions: [slowProbe],
      probeWarmup: {
        durationMs: 10_000,
        samples: [{ controlUi: slowReady, readyz: slowReady, sessionsList: slowProbe }],
      },
      sessionSeedDurationMs: 10_000,
      setupDurationMs: 20_000,
      turnsDurationMs: 30_000,
    });
    const options = testing.parseOptions(["--max-control-ms", "2000"]);
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);
    options.maxHandshakeMs = 2_000;
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      "fresh Gateway connection exceeded 2000ms: ok=true latencyMs=5000.0 error=none",
    ]);
    run.freshConnection = { error: null, latencyMs: 2_000, ok: true };
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);
    run.freshConnection = { error: "unauthorized", latencyMs: 10, ok: false };
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      "fresh Gateway connection exceeded 2000ms: ok=false latencyMs=10.0 error=unauthorized",
    ]);
  });

  it.each([
    { budgetMs: 2_000, minimumWaitMs: 0 },
    { budgetMs: 120_000, minimumWaitMs: 110_000 },
  ])(
    "bounds an accepted turn wait by its $budgetMs ms benchmark budget",
    async ({ budgetMs, minimumWaitMs }) => {
      const calls: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
      const rpc = async <T>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
        calls.push({ method, params, timeoutMs });
        return (
          method === "agent" ? { runId: "run-1", status: "accepted" } : { status: "timeout" }
        ) as T;
      };

      await expect(testing.runTurn(rpc, 0, performance.now() + budgetMs)).rejects.toThrow(
        "agent 1 did not complete",
      );

      const wait = calls.find((call) => call.method === "agent.wait");
      expect(wait?.params).toMatchObject({ runId: "run-1" });
      const serverTimeoutMs = (wait?.params as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      if (minimumWaitMs === 0) {
        expect(serverTimeoutMs).toBe(0);
      } else {
        expect(serverTimeoutMs).toBeGreaterThanOrEqual(minimumWaitMs);
      }
      expect(wait?.timeoutMs).toEqual(expect.any(Number));
      expect(Number.isInteger(wait?.timeoutMs)).toBe(true);
      expect(wait?.timeoutMs).toBeGreaterThan(serverTimeoutMs as number);
      expect(wait?.timeoutMs).toBeLessThanOrEqual(budgetMs);
    },
  );

  it("advances parallel sessions independently while serializing their own turns", async () => {
    const starts: Array<{ sessionKey: string; idempotencyKey: string; message: string }> = [];
    const startedSessions: string[] = [];
    const createTurn = () => ({
      issued: createDeferred(),
      completed: createDeferred(),
    });
    const turns = [createTurn(), createTurn(), createTurn(), createTurn()] as const;
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      if (method === "agent") {
        const request = params as (typeof starts)[number];
        starts.push(request);
        return { runId: request.idempotencyKey, status: "accepted" } as T;
      }
      const { runId } = params as { runId: string };
      const index = starts.findIndex((request) => request.idempotencyKey === runId);
      const turn = turns[index];
      if (!turn) {
        throw new Error(`Unexpected agent wait: ${runId}`);
      }
      turn.issued.resolve();
      await turn.completed.promise;
      return { status: "ok" } as T;
    };
    const [fastSession, slowSession] = ["fast", "slow"].map((sessionKey, index) =>
      testing.runSessionTurns(rpc, index, performance.now() + 60_000, {
        onStarted: () => startedSessions.push(sessionKey),
        sessionKey,
        toolEvents: true,
        turnsPerSession: 2,
      }),
    );
    await Promise.all([turns[0].issued.promise, turns[1].issued.promise]);
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow"]);

    turns[0].completed.resolve();
    await turns[2].issued.promise;
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow", "fast"]);
    turns[2].completed.resolve();
    expect(await fastSession).toBe(2);
    expect(startedSessions).toEqual(["fast", "slow"]);

    turns[1].completed.resolve();
    await turns[3].issued.promise;
    turns[3].completed.resolve();
    expect(await slowSession).toBe(2);
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow", "fast", "slow"]);
    expect(startedSessions).toEqual(["fast", "slow"]);
    expect(new Set(starts.map((request) => request.idempotencyKey)).size).toBe(4);
    expect(new Set(starts.map((request) => request.message)).size).toBe(4);
  });

  it("gives each fixed history client its full request budget despite different response times", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests: string[][] = [[], []];
    const finished: number[] = [];
    try {
      const jobs = requests.map((clientRequests, client) =>
        testing
          .runProbeRounds({
            rounds: 3,
            deadlineAt: performance.now() + 60_000,
            cadenceMs: 10,
            cadenceFrom: "completion",
            runFirst: false,
            shouldContinue: () => false,
            stopped: () => false,
            runRound: async (round) => {
              await Promise.all(
                Array.from({ length: 2 }, async (_, request) => {
                  clientRequests.push(`${round}:${request}`);
                  await new Promise<void>((resolve) => {
                    setTimeout(resolve, client * 50);
                  });
                }),
              );
            },
          })
          .then((count) => {
            finished.push(client);
            return count;
          }),
      );
      await vi.advanceTimersByTimeAsync(35);
      expect(finished).toEqual([0]);
      expect(requests.map((items) => items.length)).toEqual([6, 2]);
      await vi.runAllTimersAsync();
      expect(await Promise.all(jobs)).toEqual([3, 3]);
      expect(requests).toEqual([
        ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"],
        ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses the next fixed probe round when the load deadline is exhausted", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const issued: number[] = [];
    try {
      await expect(
        testing.runProbeRounds({
          rounds: 2,
          deadlineAt: 10,
          cadenceMs: 100,
          cadenceFrom: "start",
          runFirst: true,
          shouldContinue: () => true,
          stopped: () => false,
          runRound: async (round) => {
            issued.push(round);
            now = 11;
          },
        }),
      ).rejects.toThrow("benchmark timed out while pacing gateway probes");
      expect(issued).toEqual([0]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([true, false])(
    "preserves adaptive first-round behavior (runFirst=%s)",
    async (runFirst) => {
      const issued: number[] = [];
      expect(
        await testing.runProbeRounds({
          deadlineAt: performance.now() + 60_000,
          cadenceMs: 100,
          cadenceFrom: "start",
          runFirst,
          shouldContinue: () => false,
          stopped: () => false,
          runRound: async (round) => {
            issued.push(round);
          },
        }),
      ).toBe(runFirst ? 1 : 0);
      expect(issued).toEqual(runFirst ? [0] : []);
    },
  );

  it("joins an admitted fixed round but issues no further work after teardown starts", async () => {
    const admitted = createDeferred();
    const release = createDeferred();
    let stopped = false;
    const issued: number[] = [];
    const job = testing.runProbeRounds({
      rounds: 10,
      deadlineAt: performance.now() + 60_000,
      cadenceMs: 100,
      cadenceFrom: "completion",
      runFirst: false,
      shouldContinue: () => true,
      stopped: () => stopped,
      runRound: async (round) => {
        issued.push(round);
        admitted.resolve();
        await release.promise;
      },
    });
    await admitted.promise;
    stopped = true;
    release.resolve();
    expect(await job).toBe(1);
    expect(issued).toEqual([0]);
  });

  it("gives every gateway sample a fresh pre-warmup timeout budget", async () => {
    const deadlines: number[] = [];
    const sample = createBenchmarkRun();

    const runs = await testing.runBenchmarkSamples({
      now: (() => {
        const values = [1_000, 9_000];
        return () => values.shift() ?? 9_000;
      })(),
      options: testing.parseOptions(["--runs", "1", "--warmup", "1", "--timeout-ms", "5000"]),
      runSample: async ({ deadlineAt }) => {
        deadlines.push(deadlineAt);
        return sample;
      },
    });

    expect(deadlines).toEqual([6_000, 14_000]);
    expect(runs).toEqual([sample]);
  });

  it("preserves HTTP and RPC failures in baseline probe diagnostics", async () => {
    const probeOrder: string[] = [];
    const server = createHttpServer((req, res) => {
      probeOrder.push(req.url ?? "missing-url");
      res.statusCode = req.url === "/readyz" ? 503 : 200;
      res.end(req.url === "/readyz" ? '{"status":"starting"}' : "not html");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected HTTP test server address");
    }
    try {
      const sample = await testing.sampleGateway({
        deadlineAt: performance.now() + 5_000,
        port: address.port,
        rpc: async () => {
          probeOrder.push("sessions.list");
          throw new Error("sessions.list failed: unauthorized");
        },
        runStartedAt: performance.now(),
        serial: true,
      });

      expect(probeOrder).toEqual(["/readyz", "/", "sessions.list"]);
      expect(sample.readyz).toMatchObject({ error: null, ok: false, status: 503 });
      expect(sample.controlUi).toMatchObject({
        error: "response body did not contain <html",
        ok: false,
        status: 200,
      });
      expect(sample.sessionsList).toMatchObject({
        error: "sessions.list failed: unauthorized",
        ok: false,
      });
      const unicodeSample = await testing.sampleGateway({
        deadlineAt: performance.now() + 5_000,
        port: address.port,
        rpc: async () => {
          throw new Error(`${"x".repeat(499)}😀`);
        },
        runStartedAt: performance.now(),
        serial: true,
      });
      expect(unicodeSample.sessionsList.error).toBe("x".repeat(499));
      const failure = testing.formatRunFailure(
        new Error(testing.formatProbeFailure(sample)),
        {
          readOutput: () => "gateway output",
          readStderrTail: () => testing.tailLines("old\nfirst retained\nlast retained\n", 2),
        },
        { readOutput: () => "mock output" },
      );
      expect(failure).toMatch(
        /readyz: ok=false status=503 latencyMs=\d+\.\d error=none\n {2}sessionsList: ok=false status=n\/a latencyMs=\d+\.\d error="sessions\.list failed: unauthorized"\n {2}controlUi: ok=false status=200 latencyMs=\d+\.\d error="response body did not contain <html"/u,
      );
      expect(failure).toContain("gateway stderr tail:\nfirst retained\nlast retained");
      expect(failure).not.toContain("old");

      const healthySlow = {
        controlUi: { ...sample.controlUi, error: null, latencyMs: 200, ok: true },
        readyz: { ...sample.readyz, latencyMs: 200, ok: true, status: 200 },
        sessionsList: { ...sample.sessionsList, error: null, latencyMs: 200, ok: true },
      };
      const healthyFast = {
        controlUi: { ...healthySlow.controlUi, latencyMs: 10 },
        readyz: { ...healthySlow.readyz, degraded: true, latencyMs: 10 },
        sessionsList: { ...healthySlow.sessionsList, latencyMs: 10 },
      };
      const healthySettled = {
        ...healthyFast,
        readyz: { ...healthyFast.readyz, degraded: false },
      };
      const samples = [sample, healthySlow, healthyFast, healthySettled];
      const warmed = await testing.warmGatewayProbes({
        deadlineAt: performance.now() + 5_000,
        retryDelayMs: 0,
        sample: async () => samples.shift() ?? healthyFast,
        targetMs: 100,
      });
      expect(warmed.samples).toHaveLength(4);
    } finally {
      server.close();
    }
  });

  it("bounds trickled response bodies by the benchmark deadline", async () => {
    const sockets = new Set<Socket>();
    let bodyChunksSent = 0;
    let serverEndedResponse = false;
    const server = createRawServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n ",
        );
        bodyChunksSent += 1;
        const interval = setInterval(() => {
          socket.write(" ");
          bodyChunksSent += 1;
        }, 10);
        const endTimer = setTimeout(() => {
          serverEndedResponse = true;
          socket.end();
        }, 500);
        socket.once("close", () => {
          clearInterval(interval);
          clearTimeout(endTimer);
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected raw HTTP test server address");
    }

    const startedAt = performance.now();
    try {
      await expect(
        testing.requestHttp({
          accept: "application/json",
          deadlineAt: startedAt + 150,
          path: "/readyz",
          port: address.port,
        }),
      ).rejects.toThrow("/readyz request timed out");
      expect(bodyChunksSent).toBeGreaterThan(1);
      expect(serverEndedResponse).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("reuses one connection for sequential successful HTTP samples", async () => {
    let connectionCount = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/readyz" ? "application/json" : "text/html",
      );
      response.end(request.url === "/readyz" ? '{"status":"ok"}' : "<html></html>");
    });
    server.on("connection", () => {
      connectionCount += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected HTTP test server address");
      }
      const deadlineAt = performance.now() + 5_000;

      await testing.requestHttp({
        accept: "application/json",
        deadlineAt,
        path: "/readyz",
        port: address.port,
      });
      await testing.requestHttp({
        accept: "text/html",
        deadlineAt,
        path: "/",
        port: address.port,
      });

      expect(connectionCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("loads through native Node TypeScript stripping", () => {
    const result = spawnSync(process.execPath, ["scripts/bench-gateway-concurrency.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway concurrency benchmark");
  });

  it("ends CLI failures with the required wrapper marker", () => {
    const result = spawnSync(process.execPath, ["scripts/bench-gateway-concurrency.ts", "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
  });
});
