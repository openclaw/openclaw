// Bench Gateway Restart tests cover bench gateway restart script behavior.
import fs from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/bench-gateway-restart.ts";
import * as gatewayBenchProbes from "../../scripts/lib/gateway-bench-probes.ts";
import { parseProcessRssKb, requestProbeStatus } from "../../scripts/lib/gateway-bench-probes.ts";
import {
  flushOutputLineBuffers,
  parseNonNegativeInt,
  parsePositiveInt,
} from "../../scripts/lib/gateway-bench-runtime.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type RestartSampleFixture = Parameters<typeof testing.summarizeCase>[1][number];
type ProbeFixture = RestartSampleFixture["initialHealthz"];
type Iteration = RestartSampleFixture["iterations"][number];

const wallClockSetTimeout = setTimeout;
const wallClockClearTimeout = clearTimeout;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const benchCase = { config: {}, id: "demo", name: "demo" };

async function withServer(
  server: Server,
  run: (port: number) => Promise<void>,
  cleanup = () => {},
) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP listener");
    }
    await run(address.port);
  } finally {
    cleanup();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function iteration(overrides: Partial<Iteration> = {}): Iteration {
  return {
    ...testing.createRestartIteration(1),
    gatewayReadyLogLine: "[gateway] ready",
    gatewayReadyLogMs: 40,
    httpListenLogLine: "[gateway] http server listening (0 plugins)",
    httpListenLogMs: 20,
    healthz: createProbeFixture(30),
    readyz: createProbeFixture(42),
    ...overrides,
  };
}

function summarize(overrides: Partial<RestartSampleFixture>) {
  return testing.summarizeCase(benchCase, [createRestartSampleFixture(overrides)]);
}

function createProbeFixture(
  ms: ProbeFixture["ms"],
  overrides: Partial<ProbeFixture> = {},
): ProbeFixture {
  return {
    downtimeMs: null,
    firstErrorKind: null,
    firstRecoveryMs: null,
    ms,
    status: 200,
    transitions: [],
    unavailableMs: null,
    ...overrides,
  };
}

function createRestartSampleFixture(
  overrides: Partial<RestartSampleFixture>,
): RestartSampleFixture {
  return {
    childExitCode: 0,
    childSignal: null,
    events: [],
    exitedBeforeTeardown: false,
    failureCode: null,
    firstOutputMs: 1,
    initialGatewayReadyLogLine: "[gateway] ready",
    initialGatewayReadyLogMs: 20,
    initialHealthz: createProbeFixture(10),
    initialHttpListenLogLine: "[gateway] http server listening (0 plugins)",
    initialHttpListenLogMs: 9,
    initialReadyz: createProbeFixture(12),
    initialStartupTrace: {},
    iterations: [],
    maxRssMb: 220,
    outputTail: "",
    resourceSlope: {
      activeHandlesCountPerRestart: null,
      activeRequestsCountPerRestart: null,
      activeTimersCountPerRestart: null,
      fdCountPerRestart: null,
      heapUsedMbPerRestart: null,
      rssMbPerRestart: null,
    },
    ...overrides,
  };
}

async function withWallClockDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = wallClockSetTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    wallClockClearTimeout(timer);
  }
}

describe("gateway restart benchmark script", () => {
  it("rejects ambiguous benchmark CLI values before spawning Node", () => {
    for (const [args, message] of [
      [["--wat"], "Unknown argument: --wat"],
      [["--output", "--case", "skipChannels"], "--output requires a value"],
      [
        ["--output", "first.json", "--output", "second.json"],
        "--output was provided more than once",
      ],
      [["--case"], "--case requires a value"],
      [["--case", "skipChannels", "--case", "skipChannels"], 'Duplicate --case "skipChannels"'],
      [["--restarts", "--runs", "1"], "--restarts requires a value"],
      [["--entry", " --inspect"], /must be a file path/u],
    ] satisfies [string[], string | RegExp][]) {
      expect(() => testing.parseOptions(args)).toThrow(message);
    }
    expect(parsePositiveInt("5", 1, "--restarts")).toBe(5);
    expect(parseNonNegativeInt("0", 1, "--warmup")).toBe(0);
    expect(
      testing.parseOptions([
        "--case",
        "skipChannelsNoAcpxProbe",
        "--output",
        "restart.json",
        "--allow-failures",
        "--restarts",
        "2",
      ]),
    ).toMatchObject({
      allowFailures: true,
      cases: [{ id: "skipChannelsNoAcpxProbe" }],
      output: "restart.json",
      restarts: 2,
    });
    expect(() => parsePositiveInt("2abc", 1, "--restarts")).toThrow(
      /--restarts must be an integer/u,
    );
  });

  it("guards the SIGUSR2 restart benchmark on Windows", () => {
    expect(() => testing.ensureSupportedRestartPlatform("linux")).not.toThrow();
    expect(() => testing.ensureSupportedRestartPlatform("darwin")).not.toThrow();
    expect(() => testing.ensureSupportedRestartPlatform("win32")).toThrow(
      /not supported on Windows/u,
    );
  });

  it("flushes buffered child output carry at stream end", () => {
    const buffers = {
      stderr: "[gateway] ready",
      stdout: "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
    };
    const lines: string[] = [];

    flushOutputLineBuffers(buffers, (line) => lines.push(line), 1);

    expect(lines).toEqual([
      "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
      "[gateway] ready",
    ]);
    expect(buffers).toEqual({ stderr: "", stdout: "" });
  });

  it("counts only numeric descriptors from lsof output", () => {
    expect(
      testing.countLsofFileDescriptors(`COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1234 user  cwd    DIR    1,2      128    2 /tmp
node    1234 user  txt    REG    1,2    12345    3 /usr/bin/node
node    1234 user  mem    REG    1,2    12345    4 /usr/lib/lib.dylib
node    1234 user    0r   CHR    3,2      0t0    5 /dev/null
node    1234 user    1w   REG    1,2      123    6 /tmp/stdout
node    1234 user   12u  IPv4    0t0      TCP localhost:1234
`),
    ).toBe(3);
  });

  it("rejects malformed ps RSS samples", () => {
    expect(parseProcessRssKb("4096\n")).toBe(4096);
    expect(parseProcessRssKb("4096kb\n")).toBeNull();
    expect(parseProcessRssKb("4096 8192\n")).toBeNull();
    expect(parseProcessRssKb("0\n")).toBeNull();
    expect(parseProcessRssKb("")).toBeNull();
  });

  it("accepts healthy probe headers without waiting for the response body", async () => {
    let requestMethod: string | undefined;
    const server = createServer((request, response) => {
      requestMethod = request.method;
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
    });
    await withServer(
      server,
      async (port) => {
        // Freeze the probe deadline while real HTTP delivers headers; the watchdog stays on wall time.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await expect(
          withWallClockDeadline(requestProbeStatus(port, "/healthz"), 750, "healthy-header probe"),
        ).resolves.toEqual({ errorKind: null, status: 200 });
        expect(requestMethod).toBe("HEAD");
      },
      () => {
        vi.useRealTimers();
        server.closeAllConnections();
      },
    );
  });

  it("bounds probes by a wall-clock deadline before response headers arrive", async () => {
    const sockets = new Set<Socket>();
    const intervals = new Set<NodeJS.Timeout>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nX-Drip: ");
        // Keep the socket active without completing headers so an idle timeout cannot end the probe.
        const interval = setInterval(() => socket.write("x"), 20);
        intervals.add(interval);
        interval.unref?.();
        socket.on("close", () => {
          clearInterval(interval);
          intervals.delete(interval);
        });
      });
    });
    await withServer(
      server,
      async (port) => {
        await expect(
          withWallClockDeadline(requestProbeStatus(port, "/readyz"), 750, "headerless probe"),
        ).resolves.toEqual({ errorKind: "timeout", status: null });
      },
      () => {
        for (const interval of intervals) {
          clearInterval(interval);
        }
        for (const socket of sockets) {
          socket.destroy();
        }
      },
    );
  });

  it("enables both startup and restart trace in the child gateway environment", () => {
    const env = testing.sanitizedEnv("/tmp/openclaw-bench", "/tmp/openclaw-bench/config.json", {
      config: {},
      id: "skipChannels",
      name: "gateway restart, skip channels",
    });

    expect(env).toMatchObject({
      OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      OPENCLAW_GATEWAY_RESTART_TRACE: "1",
      OPENCLAW_NO_RESPAWN: "1",
    });
    expect(env.OPENCLAW_LOCAL_CHECK).toBeUndefined();
  });

  it("requires initial ready logs before restart attribution", () => {
    for (const initialHttpListenLogMs of [10, null]) {
      expect(
        testing.hasInitialReadyLogs({ initialGatewayReadyLogMs: 20, initialHttpListenLogMs }),
      ).toBe(initialHttpListenLogMs !== null);
    }
  });

  it("marks clean and signaled pre-teardown child exits as benchmark failures", () => {
    for (const [exitedBeforeTeardown, exitCode, signal, expected] of [
      [true, 0, null, "restart_child_exited"],
      [true, null, "SIGSEGV", "restart_child_exited"],
      [true, 9, null, "child_nonzero_exit"],
      [false, null, "SIGTERM", null],
    ] as const) {
      expect(testing.resolveSampleExitFailure({ exitedBeforeTeardown, exitCode, signal })).toBe(
        expected,
      );
    }
  });

  it("summarizes failure rate, restart.ready totals, and resource slope", () => {
    const samples: Parameters<typeof testing.summarizeCase>[1] = [
      createRestartSampleFixture({
        iterations: [
          iteration({
            readyz: createProbeFixture(42, { downtimeMs: 12 }),
            restartTrace: {
              "restart.ready": 12,
              "restart.ready.total": 50,
              "restart.ready.heapUsedMb": 100,
              "restart.ready.rssMb": 200,
            },
          }),
          iteration({
            failureCode: "trace_missing",
            healthz: createProbeFixture(35),
            readyz: createProbeFixture(50, { downtimeMs: 15 }),
            restartTrace: {
              "restart.ready.heapUsedMb": 104,
              "restart.ready.rssMb": 206,
            },
          }),
        ],
        resourceSlope: {
          activeHandlesCountPerRestart: null,
          activeRequestsCountPerRestart: null,
          activeTimersCountPerRestart: null,
          fdCountPerRestart: null,
          heapUsedMbPerRestart: 4,
          rssMbPerRestart: 6,
        },
      }),
    ];
    const result = testing.summarizeCase(benchCase, samples);

    expect(result.samples).toBe(samples);
    expect(result.summary).toMatchObject({
      failureRate: 0.5,
      firstFailureCode: "trace_missing",
      restartReadyTotalMs: { p50: 50 },
      resourceSlope: { heapUsedMbPerRestart: { p50: 4 }, rssMbPerRestart: { p50: 6 } },
    });
    expect(Object.keys(result.summary.restartTrace)).toEqual([
      "restart.ready",
      "restart.ready.heapUsedMb",
      "restart.ready.rssMb",
      "restart.ready.total",
    ]);
    expect(result.summary.restartTrace).toEqual({
      "restart.ready": { avg: 12, max: 12, min: 12, p50: 12, p95: 12 },
      "restart.ready.heapUsedMb": { avg: 102, max: 104, min: 100, p50: 102, p95: 104 },
      "restart.ready.rssMb": { avg: 203, max: 206, min: 200, p50: 203, p95: 206 },
      "restart.ready.total": { avg: 50, max: 50, min: 50, p50: 50, p95: 50 },
    });
  });

  it("counts sample failures that happen before restart iterations", () => {
    const result = summarize({
      failureCode: "initial_readyz_timeout",
    });

    expect(result.summary).toMatchObject({
      failureRate: 1,
      firstFailureCode: "initial_readyz_timeout",
    });
    expect(result.summary.restartTrace).toEqual({});
    expect(testing.hasBenchmarkFailures([result])).toBe(true);
    expect(testing.shouldFailBenchmark([result], { allowFailures: false })).toBe(true);
    expect(testing.shouldFailBenchmark([result], { allowFailures: true })).toBe(false);
  });

  it("does not mark failure-free benchmark summaries as failed", () => {
    const readyIteration = iteration({
      resourceSnapshots: [
        {
          activeHandlesCount: 8,
          activeRequestsCount: 0,
          activeTimersCount: 2,
          fdCount: 31,
          ms: 45,
          phase: "restart.ready",
          rssMb: 220,
        },
      ],
      restartTrace: {
        "restart.ready": 12,
        "restart.ready.total": 50,
        "restart.ready.rssMb": 220,
      },
    });

    const result = summarize({
      iterations: [readyIteration],
    });

    expect(testing.hasBenchmarkFailures([result])).toBe(false);
    expect(testing.hasInvalidBenchmarkEvidence([result])).toBe(false);
    expect(testing.shouldFailBenchmark([result], { allowFailures: false })).toBe(false);
  });

  it("fails successful benchmark summaries without measured restart resource evidence", () => {
    const result = summarize({
      iterations: [],
      maxRssMb: null,
    });

    expect(testing.hasBenchmarkFailures([result])).toBe(false);
    expect(testing.collectBenchmarkEvidenceFailures([result])).toEqual([
      {
        id: "demo",
        reason: "missing restart iterations",
        sampleIndex: 1,
      },
    ]);
    expect(testing.shouldFailBenchmark([result], { allowFailures: true })).toBe(true);
  });

  it("finishes restart probes when ready arrives without an unavailable window", async () => {
    let ready = false;
    // Supply a healthy observation without the real HTTP probe's load-sensitive deadline.
    const probe = vi
      .spyOn(gatewayBenchProbes, "requestProbeStatus")
      .mockImplementation(async () => {
        ready = true;
        return { errorKind: null, status: 200 };
      });
    try {
      const sampleStartAt = performance.now();
      const result = await testing.waitForRestartProbe({
        deadlineAt: sampleStartAt + 2_000,
        events: [],
        isDone: () => ready,
        iteration: 1,
        path: "/readyz",
        port: 0,
        sampleStartAt,
        signalSentAt: sampleStartAt,
      });

      expect(result).toMatchObject({
        status: 200,
        downtimeMs: null,
        unavailableMs: null,
        firstErrorKind: null,
      });
      expect(result.ms).not.toBeNull();
      expect(result.ms ?? 0).toBeLessThan(1_000);
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      probe.mockRestore();
    }
  });

  it("keeps restart probes running until HTTP recovers after an unavailable window", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.statusCode = requests === 1 ? 503 : 200;
      res.end(requests === 1 ? "warming" : "ok");
    });
    await withServer(server, async (port) => {
      const sampleStartAt = performance.now();
      const result = await testing.waitForRestartProbe({
        deadlineAt: sampleStartAt + 2_000,
        events: [],
        isDone: () => requests >= 1,
        iteration: 1,
        path: "/readyz",
        port,
        sampleStartAt,
        signalSentAt: sampleStartAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).not.toBeNull();
      expect(result.unavailableMs).not.toBeNull();
      expect(result.downtimeMs).not.toBeNull();
      expect(requests).toBeGreaterThanOrEqual(2);
    });
  });

  it("writes plugin fixtures as a parent load path with explicit startup activation", () => {
    const root = tempDirs.make("openclaw-restart-bench-config-test-");
    const configPath = testing.writeConfig(root, {
      config: {},
      id: "fiftyPlugins",
      name: "gateway restart, 50 manifest plugins",
      pluginActivationOnStartup: true,
      pluginCount: 2,
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins?: { allow?: string[]; load?: { paths?: string[] } };
    };

    expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
    expect(config.plugins?.allow).toEqual(["bench-plugin-01", "bench-plugin-02"]);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
        "utf8",
      ),
    ) as { activation?: { onStartup?: boolean } };
    expect(manifest.activation?.onStartup).toBe(true);
  });
});
