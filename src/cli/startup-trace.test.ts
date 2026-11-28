import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { sampleTrackedWorkerMemory, trackNativeWorkerForCpu } from "../infra/worker-cpu.js";
import { ExitError } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewayDispatchStartupTrace,
  formatGatewayStartupMemoryUsage,
  measureGatewayBootstrapStep,
} from "./startup-trace.js";

// The formatter runs in the Gateway main isolate; Vitest runs tests in a worker.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const timelineEvent = (type: string, name: string, fields = {}) =>
  expect.objectContaining({ type, name: `entry.${name}`, phase: "cli.startup", ...fields });
const stderrWrite = vi.fn<typeof process.stderr.write>(() => true);
const messages = () => stderrWrite.mock.calls.map(([line]) => String(line));
const makeTrace = (args: string[], source: "entry" | "cli.main" = "entry") =>
  createGatewayDispatchStartupTrace(["node", "openclaw", ...args], source);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
  stderrWrite.mockClear();
  vi.spyOn(process.stderr, "write").mockImplementation(stderrWrite);
});
afterEach(() => {
  flushDiagnosticsTimeline();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["gateway", "status"])("foreground progress: %s", async (command) => {
  const trace = makeTrace([command]);
  trace.setLineFormatter((message) => message);
  const pending = createDeferredCore<string>();
  const loading = trace.measure("run-main-import", () => pending.promise);
  expect(messages()).toEqual(
    command === "gateway"
      ? [expect.stringMatching(/startup phase: entry.run-main-import starting total=\d+\.\dms/)]
      : [],
  );
  pending.resolve("loaded");
  await expect(loading).resolves.toBe("loaded");
  expect(messages()).toHaveLength(command === "gateway" ? 2 : 0);
  if (command === "gateway") {
    expect(messages()[1]).toMatch(/startup phase: entry.run-main-import \d+\.\dms total=/);
  }
});

it.each(["0", "1"])(
  "reports pending parallel bootstrap steps only when traced (trace=%s)",
  async (enabled) => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw", "gateway", "run"]);
    const start = (name: string) => {
      const entered = createDeferredCore<boolean>();
      const done = createDeferredCore<string>();
      const result = measureGatewayBootstrapStep(name, () => {
        entered.resolve(
          messages().some((line) => line.includes(`startup trace: ${name} starting total=`)),
        );
        return done.promise;
      });
      return { entered: entered.promise, done, result };
    };
    const catalog = start("gateway.catalog-startup-snapshot");
    const model = start("gateway.model-runtime-import");
    const traced = enabled === "1";
    expect(await Promise.all([catalog.entered, model.entered])).toEqual([traced, traced]);
    expect(messages()).toHaveLength(traced ? 2 : 0);

    catalog.done.resolve("snapshot");
    await expect(catalog.result).resolves.toBe("snapshot");
    if (traced) {
      expect(messages().at(-1)).toMatch(
        /startup trace: gateway\.catalog-startup-snapshot \d+\.\dms total=/u,
      );
    }
    const failure = new Error("model unavailable");
    model.done.reject(failure);
    await expect(model.result).rejects.toBe(failure);
    expect(messages()).toHaveLength(traced ? 3 : 0);
  },
);

it.each(["0", "1"])(
  "captures phase memory before buffered logs flush (trace=%s)",
  async (enabled) => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
    const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(128 * 1024 * 1024);
    const trace = makeTrace(["gateway"], "cli.main");
    await trace.measure("gateway-run-select-environment", () => {});
    rss.mockReturnValue(256 * 1024 * 1024);
    trace.setLineFormatter((message) => message);
    expect(messages().at(-1)).toMatch(/ rssMb=128\.0 heapUsedMb=\d+\.\d workers=0 /);

    await measureGatewayBootstrapStep(
      "cli.bootstrap.admission.database-readiness",
      () => {},
      () => ({ stateIntegrityCheckCount: 1, stateIntegrityReason: "schema-mismatch" }),
    );
    expect(messages().at(-1)).toContain(
      "stateIntegrityCheckCount=1 stateIntegrityReason=schema-mismatch",
    );
    expect(messages().at(-1)).toMatch(/ rssMb=256\.0 heapUsedMb=\d+\.\d workers=0 /);
  },
);

it("reports environment selection sub-phases without full tracing only for gateway runs", async () => {
  const phases = [
    "cli.environment.imports",
    "cli.environment.config-import",
    "cli.environment.config-read",
    "cli.environment.config-recovery",
    "cli.environment.config.recovery.health-read",
    "cli.environment.config-guard",
    "cli.environment.pin-runtime-paths",
  ];
  for (const command of ["gateway", "status"]) {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw", command]);
    stderrWrite.mockClear();
    const trace = makeTrace([command], "cli.main");
    trace.setLineFormatter((message) => message);
    await trace.measure("gateway-run-select-environment-imports", () => {});
    for (const phase of phases) {
      await expect(measureGatewayBootstrapStep(phase, () => "result")).resolves.toBe("result");
    }
    await measureGatewayBootstrapStep("cli.environment.unlisted", () => {});
    expect(messages()).toHaveLength(command === "gateway" ? (phases.length + 1) * 2 : 0);
    if (command === "gateway") {
      for (const phase of ["cli.main.gateway-run-select-environment-imports", ...phases]) {
        expect(messages()).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `startup phase: ${phase} \\d+\\.\\dms total=.* rssMb=\\d+\\.\\d heapUsedMb=\\d+\\.\\d`,
            ),
          ),
        );
      }
    }
  }
});

it.each(["0", "1"])("leaves a refused start's remedy last (trace=%s)", async (enabled) => {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw", "gateway", "run"]);
  const trace = makeTrace(["gateway", "run"], "cli.main");
  trace.setLineFormatter((message) => message);
  const reason = "Free space on the PostgreSQL server, then run openclaw update.";
  const refusal = new ExitError(78, reason);
  await expect(
    trace.measure("gateway-run-pre-bootstrap", () =>
      measureGatewayBootstrapStep("cli.bootstrap.state-upgrade", () => {
        process.stderr.write(`${reason}\n`);
        throw refusal;
      }),
    ),
  ).rejects.toBe(refusal);
  expect(messages()).toHaveLength(3);
  expect(messages().at(-1)).toBe(`${reason}\n`);
});

it("formats live worker counts and cached heap coverage without requesting samples", async () => {
  const heap = vi.fn(async () => ({ ...getHeapStatistics(), total_heap_size: 12 * 1024 * 1024 }));
  const worker = Object.assign(new EventEmitter(), {
    threadId: 123,
    cpuUsage: async () => ({ user: 0, system: 0 }),
    getHeapStatistics: heap,
  });
  trackNativeWorkerForCpu(worker, new URL("fixture.worker.js", import.meta.url));
  try {
    expect(formatGatewayStartupMemoryUsage()).toMatch(/ workers=1 workerHeapSamples=0\/1$/);
    expect(heap).not.toHaveBeenCalled();
    sampleTrackedWorkerMemory();
    await Promise.resolve();
    expect(formatGatewayStartupMemoryUsage()).toMatch(
      / workers=1 workerHeapSamples=1\/1 workerHeapMb=12\.0 workerHeapSource=cached$/,
    );
    expect(heap).toHaveBeenCalledTimes(1);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 60_001);
    expect(formatGatewayStartupMemoryUsage()).toMatch(/ workers=1 workerHeapSamples=0\/1$/);
    expect(heap).toHaveBeenCalledTimes(1);
  } finally {
    worker.emit("exit");
  }
  expect(formatGatewayStartupMemoryUsage()).toMatch(
    / workers=0 workerHeapSamples=0\/0 workerHeapMb=0\.0 workerHeapSource=cached$/,
  );
});

it.each([
  [false, 2],
  [true, 1],
  [true, 2],
] as const)(
  "reports milestones only to a supporting updater (gateway: %s, markers: %i)",
  async (gateway, markers) => {
    const trace = makeTrace(
      [
        ...(gateway ? ["gateway", "run"] : ["agent"]),
        ...Array.from({ length: markers }, () => "--update-canary"),
      ],
      "cli.main",
    );
    trace.mark("argv");
    trace.mark("tick.1");
    await trace.measure("gateway-run-imports.tick.2", async () => {});
    expect(await trace.measure("gateway-run-imports", async () => "loaded")).toBe("loaded");
    await expect(
      trace.measure("gateway-run-bootstrap", () => Promise.reject(new Error("bootstrap failed"))),
    ).rejects.toThrow("bootstrap failed");
    expect(messages()).toEqual(
      gateway && markers >= 2
        ? [
            "openclaw-update-canary-progress: cli.main.argv\n",
            "openclaw-update-canary-progress: cli.main.gateway-run-imports\n",
          ]
        : [],
    );
  },
);

it.each(["timeline", ""])(
  "retains observed startup times through delayed activation and flush with diagnostics=%j",
  async (diagnostics) => {
    const timelinePath = path.join(directories.make("openclaw-startup-trace-"), "timeline.jsonl");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", diagnostics);
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);
    const origin = performance.timeOrigin;
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ["Date"] });
    const timestamp = (elapsed: number) => new Date(origin + elapsed).toISOString();
    const trace = makeTrace(["agent", "--local"]);
    now = 120;
    trace.mark("bootstrap");
    now = 200;
    const loading = trace.measure("run-main-import", () => {
      now = 350;
      vi.setSystemTime(origin + now);
      return "loaded";
    });
    // Activation awaits must not move the earlier mark or backdate the operation's start.
    now = 300;
    vi.setSystemTime(origin + now);
    await expect(loading).resolves.toBe("loaded");
    await expect(
      trace.measure("command-execution", async () => "done", { timeline: false }),
    ).resolves.toBe("done");

    now = 1_000;
    vi.setSystemTime(origin + now);
    if (!diagnostics) {
      expect(await trace.requiresDiagnosticsConfig()).toBe(true);
      expect(fs.existsSync(timelinePath)).toBe(false);
      await trace.configureDiagnosticsTimeline({ diagnostics: { flags: ["timeline"] } });
    }

    now = 1_100;
    trace.mark("configured");
    now = 2_000;
    // A wall-clock adjustment during the queued write must not change its observed time.
    vi.setSystemTime(origin - 60_000);
    await trace.configureDiagnosticsTimeline({ diagnostics: { flags: ["timeline"] } });
    flushDiagnosticsTimeline();
    const events = fs
      .readFileSync(timelinePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        timelineEvent("mark", "bootstrap", {
          timestamp: timestamp(120),
          durationMs: 20,
          attributes: expect.objectContaining({ totalMs: 20 }),
        }),
        timelineEvent("span.start", "run-main-import", { timestamp: timestamp(300) }),
        timelineEvent("span.end", "run-main-import", {
          timestamp: timestamp(350),
          durationMs: 50,
        }),
        timelineEvent("mark", "configured", {
          timestamp: timestamp(1_100),
          attributes: expect.objectContaining({ totalMs: 1_000 }),
        }),
      ]),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ name: "entry.command-execution" }));
  },
);
