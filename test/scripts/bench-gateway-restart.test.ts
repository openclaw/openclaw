import { createServer } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { testing } from "../../scripts/bench-gateway-restart.ts";
import * as gatewayBenchProbes from "../../scripts/lib/gateway-bench-probes.ts";
import { parseProcessRssKb, requestProbeStatus } from "../../scripts/lib/gateway-bench-probes.ts";
import { flushOutputLineBuffers } from "../../scripts/lib/gateway-bench-runtime.ts";

type RestartSampleFixture = Parameters<typeof testing.summarizeCase>[1][number];
type ProbeFixture = RestartSampleFixture["initialHealthz"];
type Iteration = RestartSampleFixture["iterations"][number];
type ServerRun = (port: number) => Promise<void>;

const wallClockSetTimeout = setTimeout;
const wallClockClearTimeout = clearTimeout;
const benchCase = { config: {}, id: "demo", name: "demo" };

async function withServer(server: Server, run: ServerRun, cleanup = () => {}) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
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
    for (const socket of sockets) {
      socket.destroy();
    }
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
    healthz: probe(30),
    readyz: probe(42),
    ...overrides,
  };
}

function summarize(overrides: Partial<RestartSampleFixture>) {
  return testing.summarizeCase(benchCase, [sample(overrides)]);
}

function restartProbe(isDone: () => boolean, port = 0) {
  const sampleStartAt = performance.now();
  return testing.waitForRestartProbe({
    deadlineAt: sampleStartAt + 2_000,
    events: [],
    isDone,
    iteration: 1,
    path: "/readyz",
    port,
    sampleStartAt,
    signalSentAt: sampleStartAt,
  });
}

function probe(ms: ProbeFixture["ms"], downtimeMs: number | null = null): ProbeFixture {
  return {
    downtimeMs,
    firstErrorKind: null,
    firstRecoveryMs: null,
    ms,
    status: 200,
    transitions: [],
    unavailableMs: null,
  };
}

function sample(overrides: Partial<RestartSampleFixture>): RestartSampleFixture {
  return {
    childExitCode: 0,
    childSignal: null,
    events: [],
    exitedBeforeTeardown: false,
    failureCode: null,
    firstOutputMs: 1,
    initialGatewayReadyLogLine: "[gateway] ready",
    initialGatewayReadyLogMs: 20,
    initialHealthz: probe(10),
    initialHttpListenLogLine: "[gateway] http server listening (0 plugins)",
    initialHttpListenLogMs: 9,
    initialReadyz: probe(12),
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

it("rejects Node option entries and resolves restart benchmark controls", () => {
  expect(() => testing.parseOptions(["--entry", " --inspect"])).toThrow(/must be a file path/u);
  expect(
    testing.parseOptions(
      "--case skipChannelsNoAcpxProbe --output restart.json --allow-failures --restarts 2".split(
        " ",
      ),
    ),
  ).toMatchObject({
    allowFailures: true,
    cases: [{ id: "skipChannelsNoAcpxProbe" }],
    output: "restart.json",
    restarts: 2,
  });
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
  const rows = ["cwd", "txt", "mem", "0r", "1w", "12u"].map((fd) => `node 1234 user ${fd}`);
  expect(testing.countLsofFileDescriptors(["COMMAND PID USER FD", ...rows].join("\n"))).toBe(3);
});

it("rejects malformed ps RSS samples", () => {
  expect(parseProcessRssKb("4096\n")).toBe(4096);
  for (const value of ["4096kb\n", "4096 8192\n", "0\n", ""]) {
    expect(parseProcessRssKb(value)).toBeNull();
  }
});

async function probeWithinBudget(port: number) {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = wallClockSetTimeout(() => reject(new Error("probe exceeded 750ms")), 750);
    timer.unref?.();
  });
  try {
    return await Promise.race([requestProbeStatus(port, "/readyz"), deadline]);
  } finally {
    wallClockClearTimeout(timer);
  }
}

it("probes healthy headers without waiting for a body", async () => {
  let method: string | undefined;
  const server = createServer((request, response) => {
    method = request.method;
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  });
  await withServer(
    server,
    async (port) => {
      // Freeze the probe timer, but not the independent watchdog.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect(await probeWithinBudget(port)).toEqual({ errorKind: null, status: 200 });
      expect(method).toBe("HEAD");
    },
    () => vi.useRealTimers(),
  );
});

it("times out incomplete headers despite continued socket activity", async () => {
  const intervals = new Set<NodeJS.Timeout>();
  const server = createNetServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nX-Drip: ");
      const interval = setInterval(() => socket.write("x"), 20);
      intervals.add(interval);
      interval.unref?.();
    });
  });
  await withServer(
    server,
    async (port) => {
      expect(await probeWithinBudget(port)).toEqual({ errorKind: "timeout", status: null });
    },
    () => {
      for (const interval of intervals) {
        clearInterval(interval);
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
  const result = summarize({
    iterations: [
      iteration({
        readyz: probe(42, 12),
        restartTrace: {
          "restart.ready": 12,
          "restart.ready.total": 50,
          "restart.ready.heapUsedMb": 100,
          "restart.ready.rssMb": 200,
        },
      }),
      iteration({
        failureCode: "trace_missing",
        healthz: probe(35),
        readyz: probe(50, 15),
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
  });
  expect(result.summary).toMatchObject({
    failureRate: 0.5,
    firstFailureCode: "trace_missing",
    restartReadyTotalMs: { p50: 50 },
    resourceSlope: { heapUsedMbPerRestart: { p50: 4 }, rssMbPerRestart: { p50: 6 } },
  });
  const expectedTrace = {
    "restart.ready": { avg: 12, max: 12, min: 12, p50: 12, p95: 12 },
    "restart.ready.heapUsedMb": { avg: 102, max: 104, min: 100, p50: 102, p95: 104 },
    "restart.ready.rssMb": { avg: 203, max: 206, min: 200, p50: 203, p95: 206 },
    "restart.ready.total": { avg: 50, max: 50, min: 50, p50: 50, p95: 50 },
  };
  expect(result.summary.restartTrace).toEqual(expectedTrace);
});

it("counts sample failures that happen before restart iterations", () => {
  const result = summarize({ failureCode: "initial_readyz_timeout" });

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
    restartTrace: {
      "restart.ready": 12,
      "restart.ready.total": 50,
      "restart.ready.rssMb": 220,
    },
  });
  const result = summarize({ iterations: [readyIteration] });

  expect(testing.hasBenchmarkFailures([result])).toBe(false);
  expect(testing.hasInvalidBenchmarkEvidence([result])).toBe(false);
  expect(testing.shouldFailBenchmark([result], { allowFailures: false })).toBe(false);
});

it("fails successful benchmark summaries without measured restart resource evidence", () => {
  const result = summarize({ iterations: [], maxRssMb: null });

  expect(testing.hasBenchmarkFailures([result])).toBe(false);
  expect(testing.collectBenchmarkEvidenceFailures([result])).toEqual([
    { id: "demo", reason: "missing restart iterations", sampleIndex: 1 },
  ]);
  expect(testing.shouldFailBenchmark([result], { allowFailures: true })).toBe(true);
});

it("finishes restart probes when ready arrives without an unavailable window", async () => {
  let ready = false;
  // Supply a healthy observation without the real HTTP probe's load-sensitive deadline.
  const requestProbe = vi
    .spyOn(gatewayBenchProbes, "requestProbeStatus")
    .mockImplementation(async () => {
      ready = true;
      return { errorKind: null, status: 200 };
    });
  try {
    const result = await restartProbe(() => ready);

    expect(result).toMatchObject({
      status: 200,
      downtimeMs: null,
      unavailableMs: null,
      firstErrorKind: null,
    });
    expect(result.ms).not.toBeNull();
    expect(result.ms ?? 0).toBeLessThan(1_000);
    expect(requestProbe).toHaveBeenCalledOnce();
  } finally {
    requestProbe.mockRestore();
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
    const result = await restartProbe(() => requests >= 1, port);

    expect(result.status).toBe(200);
    expect(result.ms).not.toBeNull();
    expect(result.unavailableMs).not.toBeNull();
    expect(result.downtimeMs).not.toBeNull();
    expect(requests).toBeGreaterThanOrEqual(2);
  });
});
