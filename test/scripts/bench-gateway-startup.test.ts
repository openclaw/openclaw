// Bench Gateway Startup tests cover bench gateway startup script behavior.
import fs from "node:fs";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-gateway-startup.ts";
import {
  classifyGatewayReadyLog,
  collectOutputLines,
  collectTraceLine,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../../scripts/lib/gateway-bench-runtime.ts";
import { isStartupTraceDuration } from "../../scripts/lib/gateway-startup-trace-ranking.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { validateConfigObject } from "../../src/config/validation.js";
import { isPidAlive } from "../../src/shared/pid-alive.js";
import { waitForPidToExit } from "../../src/test-utils/process-tree.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parseOptions = (args: string) => testing.parseOptions(args.split(" "));

function resolveBenchCase(id: string) {
  const value = testing.parseOptions(["--case", id]).cases[0];
  if (!value) {
    throw new Error(`expected benchmark case ${id}`);
  }
  return value;
}

function readConfig(root: string, value: Parameters<typeof testing.writeConfig>[1]) {
  return JSON.parse(fs.readFileSync(testing.writeConfig(root, value), "utf8")) as OpenClawConfig;
}

function readPlugin(root: string, file: string, id = "bench-plugin-01") {
  return fs.readFileSync(path.join(root, "plugins", id, file), "utf8");
}

function runStartup(root: string, signal: AbortSignal, args: string[], preload?: string) {
  return runNodeScript(
    [
      ...(preload ? ["--import", preload] : []),
      "--import",
      "tsx",
      "scripts/bench-gateway-startup.ts",
      ...args,
    ],
    { ...process.env, TMPDIR: root },
    undefined,
    { cwd: process.cwd(), signal, maxBuffer: 1024 * 1024, requireProcessTreeExit: true },
  );
}

type GatewaySample = Parameters<typeof testing.summarizeCase>[1][number];

function startupProbe(
  ms: number | null,
  firstErrorKind: string | null = null,
): GatewaySample["healthz"] {
  return {
    firstErrorKind,
    firstRecoveryMs: ms,
    ms,
    status: ms === null ? null : 200,
    transitions: [],
  };
}

function gatewaySample(overrides: Partial<GatewaySample> = {}): GatewaySample {
  return {
    completionMs: 20,
    cpuCoreRatio: 0.5,
    cpuMs: 100,
    exitCode: null,
    firstOutputMs: 1,
    firstSessionRpc: { ms: 19, attempts: 1, lastError: null },
    gatewayReadyLogLine: "[gateway] ready",
    gatewayReadyLogMs: 20,
    healthz: startupProbe(10, "econnrefused"),
    httpListenLogLine: "[gateway] http server listening (0 plugins)",
    httpListenLogMs: 5,
    maxRssMb: 120,
    outputTail: "",
    readyz: startupProbe(18, "http-503"),
    shutdownForced: false,
    shutdownMs: 5,
    signal: null,
    startupTrace: {},
    startupTraceLines: [],
    ...overrides,
  };
}

async function listenOnLoopback(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected loopback port");
  }
  return { port: address.port, server };
}

describe("gateway startup benchmark script", () => {
  it.skipIf(process.platform === "win32")(
    "reports an unavailable high-port range without retrying indefinitely",
    async ({ signal }) => {
      const root = tempDirs.make("openclaw-bench-low-ports-");
      const entry = path.join(root, "entry.mjs");
      const preload = path.join(root, "low-ports.mjs");
      fs.writeFileSync(entry, 'throw new Error("Gateway must not start without a usable port");');
      fs.writeFileSync(
        preload,
        `import { Server } from "node:net";
const address = Server.prototype.address;
let attempts = 0;
Server.prototype.address = function () {
  const result = address.call(this);
  if (result && typeof result === "object") {
    // Fail the fixture before an unbounded retry loop can hang the test process.
    if (++attempts > 1000) throw new Error("unbounded port allocation retries");
    return { ...result, port: 39999 };
  }
  return result;
};`,
      );
      const result = await runStartup(
        root,
        signal,
        ["--entry", entry, "--case", "skipChannels", "--runs", "1", "--warmup", "0"],
        preload,
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not allocate a benchmark port >= 40000");
    },
  );

  // Strict managed process-group verification is not supported on Windows.
  it.skipIf(process.platform === "win32")(
    "requires seeded session access and clean shutdown only for populated fixtures",
    async ({ signal }) => {
      const fixtures = createTempDirTracker();
      const root = fixtures.make("openclaw-bench-count-report-");
      const entry = path.join(root, "entry.mjs");
      const counter = path.join(root, "counter.json");
      const eventsPath = path.join(root, "events.jsonl");
      const reportPath = path.join(root, "report.json");
      type FixtureEvent = {
        phase: string;
        pid: number;
        home?: string;
        method?: string;
        status?: number;
        path?: string;
        ok?: boolean;
        port?: number;
        sessionCount?: number;
      };
      const readEvents = (): FixtureEvent[] =>
        fs.existsSync(eventsPath)
          ? fs
              .readFileSync(eventsPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      try {
        fs.writeFileSync(
          entry,
          `import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(${JSON.stringify(path.resolve("package.json"))})("ws");
const counter = ${JSON.stringify(counter)};
const teamBootFixture = process.env.OPENCLAW_HOME + "/team-boot-fixture.json";
const teamBoot = existsSync(teamBootFixture);
const gatewayConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
if (teamBoot && process.argv[process.argv.indexOf("--auth") + 1] !== "token") throw new Error("expected teamBoot token auth");
const shutdownExitCode = teamBoot ? JSON.parse(readFileSync(teamBootFixture, "utf8")).shutdownExitCode ?? 0 : 0;
const record = (phase, extra = {}) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ phase, pid: process.pid, ...extra }) + "\\n");
const sample = (existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, JSON.stringify(sample));
record("started", { home: process.env.OPENCLAW_HOME });
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
record("port", { port });
const server = createServer((req, res) => {
  const status = req.method === "HEAD" && ["/healthz", "/readyz"].includes(req.url) ? 200 : 404;
  record("probe", { method: req.method, status, path: req.url });
  res.writeHead(status, { connection: "close" });
  res.end();
});
let sessionRequests = 0;
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    const ok = request.method === "connect"
      ? !teamBoot || request.params.auth?.token === gatewayConfig.gateway.auth.token
      : ++sessionRequests > 1;
    const sessions = teamBoot && sessionRequests >= 3
      ? [{ key: sessionRequests === 3 ? "unrelated-session" : "agent:incident-agent-01:bench-0" }]
      : [];
    record("rpc", { method: request.method, ok, sessionCount: sessions.length });
    socket.send(JSON.stringify({ type: "res", id: request.id, ok,
      ...(ok ? { payload: request.method === "sessions.list" ? { sessions } : {} }
             : { error: { message: "session access is starting" } }) }));
  });
});
let stopping = false;
const stop = (reason) => {
  if (stopping) return;
  stopping = true;
  server.close(() => { record("closed", { reason }); process.exit(shutdownExitCode); });
};
process.on("SIGTERM", () => stop("signal"));
// The CLI owns stdin; EOF retires this detached fixture when the CLI is cancelled.
process.stdin.on("end", () => stop("stdin-eof"));
process.stdin.resume();
server.listen(port, "127.0.0.1", () => {
  const ids = teamBoot ? gatewayConfig.plugins.allow : [];
  console.log("[gateway] http server listening (" + (ids.length ? ids.length + " plugins: " + ids.join(", ") + "; 0.0s" : "0 plugins, 0.0s") + ")");
  console.log("[gateway] ready (0 plugins, 0.0s)");
  console.log("startup trace: sidecars.model-runtime-build agentCount=" + (10 + sample) + " workspaceGroupCount=" + sample + " workspaceFactsMs=2.5");
  console.log("startup trace: memory.ready rssMb=32.5 heapUsedMb=16.25 externalMb=2");
});
`,
        );
        const result = await runStartup(root, signal, [
          "--entry",
          entry,
          ..."--case default --runs 2 --warmup 0 --output".split(" "),
          reportPath,
        ]);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const events = readEvents();
        const started = events.filter((event) => event.phase === "started");
        expect(started).toHaveLength(2);
        expect(events.filter((event) => event.phase === "closed")).toHaveLength(2);
        expect(
          events.filter((event) => event.phase === "port").every((event) => event.port! >= 40000),
        ).toBe(true);
        const probes = events.filter((event) => event.phase === "probe");
        for (const probe of probes) {
          expect(probe).toMatchObject({ method: "HEAD", status: 200 });
        }
        for (const event of started) {
          expect(
            probes.filter((probe) => probe.pid === event.pid).map((probe) => probe.path),
          ).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
          expect(isPidAlive(event.pid)).toBe(false);
          expect(event.home).toBeDefined();
          expect(fs.existsSync(event.home!)).toBe(false);
          expect(
            events
              .filter((request) => request.pid === event.pid && request.method === "sessions.list")
              .map((request) => request.ok),
          ).toEqual([false, true]);
        }
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        expect(report.results).toHaveLength(1);
        expect(report.results[0].samples).toHaveLength(2);
        for (const sample of report.results[0].samples) {
          expect(sample.firstSessionRpc).toMatchObject({ ms: expect.any(Number), attempts: 2 });
          expect(sample.startupTraceLines).toHaveLength(2);
        }
        expect(report.results[0].summary.startupTrace).toMatchObject({
          "sidecars.model-runtime-build.agentCount": { p50: 11.5, avg: 11.5, min: 11, max: 12 },
          "sidecars.model-runtime-build.workspaceGroupCount": {
            p50: 1.5,
            avg: 1.5,
            min: 1,
            max: 2,
          },
          "sidecars.model-runtime-build.workspaceFactsMs": { p50: 2.5, avg: 2.5 },
        });
        expect(result.stdout).toContain("workspaceFacts=p50=2.5ms");
        expect(result.stdout).toContain("ready memory: rss=p50=32.5MB");
        expect(result.stdout).toContain("runtimePlugins=n/a");
        expect(result.stdout).toContain("sessions RPC: p50=");
        expect(result.stdout).toMatch(
          / {2}CPU core:\s+p50=\d+\.\d{3} avg=\d+\.\d{3} min=\d+\.\d{3} max=\d+\.\d{3}/u,
        );
        const counts = result.stdout
          .split("\n")
          .find((line) => line.startsWith("  prepared runtime:"));
        expect(counts).toContain("agents=p50=11.5 avg=11.5 min=11 max=12");
        expect(counts).toContain("workspaces=p50=1.5 avg=1.5 min=1 max=2");

        // This fake Gateway tests the driver protocol, not the heavyweight seed generator.
        const teamRoot = path.join(root, "prepared-team-boot");
        fs.mkdirSync(teamRoot);
        const bundledPluginFixture = { plugins: { allow: ["openai", "google"] } };
        const bundledPluginFixturePath = path.join(root, "bundled-plugins.json");
        fs.writeFileSync(bundledPluginFixturePath, JSON.stringify(bundledPluginFixture));
        const runPopulated = () =>
          runStartup(root, signal, [
            "--entry",
            entry,
            "--case",
            "teamBoot",
            "--bundled-plugin-fixture",
            bundledPluginFixturePath,
            "--fixture-root",
            teamRoot,
            ..."--runs 1 --warmup 0 --output".split(" "),
            reportPath,
          ]);
        for (const shutdownExitCode of [0, 23]) {
          fs.writeFileSync(
            path.join(teamRoot, "team-boot-fixture.json"),
            JSON.stringify({
              shutdownExitCode,
              bundledPluginFixture,
              externalPluginCount: 42,
            }),
          );
          const populated = await runPopulated();
          expect(populated.error).toBeUndefined();
          expect(populated.status, populated.stderr).toBe(shutdownExitCode === 0 ? 0 : 1);
          if (shutdownExitCode !== 0) {
            expect(populated.stderr).toContain("unclean shutdown");
          }
          const populatedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
          expect(populatedReport.fixture).toMatchObject({
            bundledPluginFixture,
            externalPluginCount: 42,
          });
          expect(populatedReport.results[0].samples[0]).toMatchObject({
            exitCode: shutdownExitCode,
            shutdownForced: false,
            shutdownMs: expect.any(Number),
            signal: null,
          });
          expect(populatedReport.results[0].summary.shutdownMs).toMatchObject({
            p50: expect.any(Number),
          });
          expect(populated.stdout).toContain("shutdown:     p50=");
          expect(populatedReport.results[0].samples[0].firstSessionRpc).toMatchObject({
            ms: expect.any(Number),
            attempts: 4,
          });
          const populatedPid = readEvents().findLast(
            (event) => event.phase === "started" && event.home === teamRoot,
          )?.pid;
          expect(populatedPid).toEqual(expect.any(Number));
          expect(
            readEvents()
              .filter((event) => event.pid === populatedPid && event.method === "sessions.list")
              .map(({ ok, sessionCount }) => ({ ok, sessionCount })),
          ).toEqual([
            { ok: false, sessionCount: 0 },
            { ok: true, sessionCount: 0 },
            { ok: true, sessionCount: 1 },
            { ok: true, sessionCount: 1 },
          ]);
        }
      } finally {
        // Never signal retired PIDs; retain fixture evidence if an unclosed child remains alive.
        const events = readEvents();
        const closed = new Set(
          events.filter((event) => event.phase === "closed").map((event) => event.pid),
        );
        for (const startedEvent of events.filter((event) => event.phase === "started")) {
          if (!closed.has(startedEvent.pid)) {
            expect(
              await waitForPidToExit(startedEvent.pid),
              `Unclosed fixture retained at ${root}`,
            ).toBe(true);
          }
        }
        fixtures.cleanup();
      }
    },
  );

  it("validates installed-cohort controls and selected benchmark options", () => {
    for (const [args, error] of [
      ["--installed-cpu-diagnostic", "--installed-cpu-diagnostic requires --installed-cohort"],
      ["--case default --case default", 'Duplicate --case "default"'],
    ] as const) {
      expect(() => parseOptions(args)).toThrow(error);
    }
    for (const flag of [
      "--cpu-prof-dir",
      "--heap-prof-dir",
      "--gateway-runtime",
      "--gateway-cpus",
    ]) {
      expect(() =>
        parseOptions(`--installed-cohort input.json --output result.json ${flag} profiles`),
      ).toThrow(`${flag} is not supported with --installed-cohort`);
    }
    expect(
      parseOptions("--case default --output startup.json --json --heap-prof-dir profiles --runs 2"),
    ).toMatchObject({
      cases: [{ id: "default" }],
      json: true,
      heapProfDir: "profiles",
      output: "startup.json",
      runs: 2,
    });
  });

  it("selects the Gateway runtime and affinity independently of the controller", () => {
    expect(testing.parseOptions([]).gatewayRuntime).toBe(process.execPath);
    expect(
      testing.parseOptions(["--gateway-runtime", "/tmp/bun", "--gateway-cpus", "0,1"]),
    ).toMatchObject({ gatewayRuntime: "/tmp/bun", gatewayCpus: "0,1" });
  });

  it("forces incident packaged-plugin cases to load built plugin entries", () => {
    const env = createGatewayBenchEnv("/tmp/openclaw-bench", "/tmp/openclaw-bench/config.json", {
      caseEnv: resolveBenchCase("incidentCombined").env,
    });

    expect(env.OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS).toBeUndefined();
  });

  it("requires the full packaged plugin inventory even when a build filter is set", () => {
    const filteredEnv = { ...process.env, OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "telegram" };

    expect(testing.listIncidentPackagedPluginArtifacts(filteredEnv)).toEqual(
      testing.listIncidentPackagedPluginArtifacts({
        ...process.env,
        OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
      }),
    );
  });

  it("classifies HTTP listen and gateway ready logs separately", () => {
    expect(classifyGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)")).toBe(
      "http-listen",
    );
    expect(classifyGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe("gateway-ready");
    expect(classifyGatewayReadyLog("[gateway] ready")).toBe("gateway-ready");
    expect(classifyGatewayReadyLog("[gateway] starting HTTP server...")).toBeNull();
  });

  it("preserves ready and trace records split across output chunks", () => {
    const chunks = [
      "[gateway] rea",
      "dy (0 plugins, 0.8s)\nstartup trace: side",
      "cars.ready 2.0ms total=7.5ms heapUsedMb=12.0\n",
    ];
    let carry = "";
    const lines: string[] = [];
    for (const chunk of chunks) {
      const parsed = collectOutputLines(carry, chunk);
      carry = parsed.carry;
      lines.push(...parsed.lines);
    }
    const trace: Record<string, number> = {};
    for (const line of lines) {
      collectTraceLine(line, "startup trace", trace);
    }

    expect(carry).toBe("");
    expect(lines.map(classifyGatewayReadyLog)).toContain("gateway-ready");
    expect(trace).toMatchObject({
      "sidecars.ready": 2,
      "sidecars.ready.heapUsedMb": 12,
      "sidecars.ready.total": 7.5,
    });
  });

  it("flags samples that never produced readiness or process metrics", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      gatewaySample({
        completionMs: null,
        cpuCoreRatio: null,
        cpuMs: null,
        exitCode: 1,
        firstOutputMs: 5,
        firstSessionRpc: { ms: null, attempts: 0, lastError: null },
        gatewayReadyLogLine: null,
        gatewayReadyLogMs: null,
        healthz: startupProbe(null, "econnrefused"),
        httpListenLogLine: null,
        httpListenLogMs: null,
        maxRssMb: null,
        outputTail: "Error: Cannot find module 'dist/entry.js'",
        readyz: startupProbe(null, "econnrefused"),
      }),
    ]);

    expect(result.summary.startupTrace).toEqual({});
    expect(testing.collectResultFailures([result])).toEqual([
      {
        id: "demo",
        reason: "missing /healthz, /readyz, sessions.list, completion, cpu, rss",
        sampleIndex: 1,
      },
    ]);
  });

  it.each([
    { exitCode: 1, signal: null, reason: "child exited 1" },
    { exitCode: null, signal: "SIGSEGV" as const, reason: "child exited by SIGSEGV" },
  ])("flags samples that become ready and then fail: $reason", ({ exitCode, signal, reason }) => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      gatewaySample({
        exitedBeforeTeardown: true,
        exitCode,
        signal,
        outputTail: "ready\\nError: startup sidecar crashed",
      }),
    ]);

    expect(result.summary.httpListenLogMs?.p50).toBe(5);
    expect(result.summary.gatewayReadyLogMs?.p50).toBe(20);
    expect("readyLogMs" in result.summary).toBe(false);
    expect(testing.collectResultFailures([result])).toEqual([
      { id: "demo", reason, sampleIndex: 1 },
    ]);
  });

  it.each([
    { fast: 5, slow: 11, errors: 0, valid: true },
    { fast: 11, slow: 12, errors: 0, valid: false },
    { fast: 5, slow: 9, errors: 0, valid: false },
    { fast: 5, slow: 11, errors: 1, valid: false },
  ])(
    "enforces independent slow-agent recovery (fast=$fast, slow=$slow, errors=$errors)",
    ({ fast, slow, errors, valid }) => {
      const result = testing.summarizeCase(
        { config: {}, id: "slowAgentDatabase", name: "slow agent database" },
        [
          gatewaySample({
            agentRecoveryMs: {
              "bench-fast-01": 3,
              "bench-fast-02": 4,
              "bench-fast-03": 5,
              "bench-fast-04": fast,
              "bench-slow": slow,
            },
            integrityGateMs: { "gate-start": 2, "gate-passed": 10 },
            agentDatabaseAdmissionErrors: errors,
          }),
        ],
      );
      expect(testing.collectResultFailures([result]).length === 0).toBe(valid);
    },
  );

  it("enforces the combined incident readiness budgets", () => {
    const result = testing.summarizeCase({ config: {}, id: "incidentCombined", name: "incident" }, [
      gatewaySample({
        completionMs: 60_000,
        exitCode: 0,
        gatewayReadyLogMs: 60_000,
        healthz: startupProbe(30_000),
        readyz: startupProbe(60_000),
      }),
    ]);

    expect(testing.collectResultFailures([result])).toEqual([
      {
        id: "incidentCombined",
        reason: "/healthz p95 30000.0ms must be under 30000.0ms",
        sampleIndex: 0,
      },
      {
        id: "incidentCombined",
        reason: "/readyz p95 60000.0ms must be under 60000.0ms",
        sampleIndex: 0,
      },
    ]);
  });

  it("collects Count-suffixed startup trace metrics", () => {
    const startupTrace: Record<string, number> = {};

    collectTraceLine(
      "[gateway] startup trace: sidecars.acp.runtime-ready ready=1 readyCount=1 backend=acpx",
      "startup trace",
      startupTrace,
    );

    expect(startupTrace["sidecars.acp.runtime-ready.ready"]).toBeUndefined();
    expect(startupTrace["sidecars.acp.runtime-ready.readyCount"]).toBe(1);
  });

  it("uses the recorded trace total for completion timing", async () => {
    const startedAt = performance.now();
    const completionMs = await testing.waitForStartupTracePhase({
      deadlineAt: startedAt + 1_000,
      isDone: () => false,
      phase: "sidecars.ready",
      startupTrace: {
        "sidecars.ready": 20,
        "sidecars.ready.total": 50,
      },
    });

    expect(completionMs).toBe(50);
  });

  it("keeps counts and memory metrics out of the slow-duration ranking", () => {
    expect(isStartupTraceDuration("plugins.runtime-post-bind")).toBe(true);
    expect(isStartupTraceDuration("plugins.gateway-load.loadMs")).toBe(true);
    expect(isStartupTraceDuration("ready.eventLoopMax")).toBe(true);
    expect(isStartupTraceDuration("plugins.runtime-post-bind.gatewayMethodCount")).toBe(false);
    expect(isStartupTraceDuration("memory.ready.rssMb")).toBe(false);
    expect(isStartupTraceDuration("ready.total")).toBe(false);
  });

  it("records probe state transitions, first error kind, and first recovery", async () => {
    let calls = 0;
    const { port, server } = await listenOnLoopback((_req, res) => {
      calls += 1;
      res.statusCode = calls === 1 ? 503 : 200;
      res.end("ok");
    });
    try {
      const startAt = performance.now();
      const result = await waitForInitialProbe({
        deadlineAt: startAt + 1_000,
        path: "/readyz",
        port,
        startAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).toEqual(expect.any(Number));
      expect(result.firstErrorKind).toBe("http-503");
      expect(result.firstRecoveryMs).toEqual(expect.any(Number));
      expect(result.transitions.map((transition) => transition.status)).toEqual([503, 200]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("builds a bounded incident fixture before the startup timer begins", async () => {
    const root = tempDirs.make("openclaw-incident-bench-test-");
    await testing.writeIncidentFixture(root, {
      kind: "combined",
      auditRowCount: 2_000,
      workspaceFileBytes: 32,
      workspaceFileCount: 6,
    });
    const { DatabaseSync } = await import("node:sqlite");
    const statePath = path.join(root, "state", "state", "openclaw.sqlite");
    const state = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(state.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
        count: 1_000,
      });
      const freelist = state.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
      expect(freelist.freelist_count).toBeGreaterThan(0);
      expect(
        state.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({
        app_version: null,
      });
    } finally {
      state.close();
    }
    for (let index = 1; index <= 8; index += 1) {
      const agent = new DatabaseSync(
        path.join(
          root,
          "state",
          "agents",
          `incident-agent-${String(index).padStart(2, "0")}`,
          "agent",
          "openclaw-agent.sqlite",
        ),
        { readOnly: true },
      );
      try {
        expect(
          agent.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({
          app_version: null,
        });
      } finally {
        agent.close();
      }
    }
    expect(
      fs.statSync(
        path.join(
          root,
          "workspaces",
          "agent-01",
          "incident-artifacts",
          "batch-000",
          "artifact-000000.bin",
        ),
      ).size,
    ).toBe(32);
  });

  it("removes the benchmark fixture when a sample fails", async () => {
    let fixtureRoot = "";

    await expect(
      testing.withGatewayBenchRoot(async (root) => {
        fixtureRoot = root;
        fs.writeFileSync(path.join(root, "fixture"), "test");
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");

    expect(fs.existsSync(fixtureRoot)).toBe(false);
  });

  it("builds a deterministic prepared-runtime catalog stall case", () => {
    const root = tempDirs.make("openclaw-bench-config-test-");
    const config = readConfig(root, resolveBenchCase("preparedRuntimeCatalogStall"));
    expect(config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "bench-catalog-stall/bench-model",
    ]);
    expect(validateConfigObject(config)).toMatchObject({ ok: true });
    const pluginId = config.plugins?.allow?.[0];
    expect(pluginId).toBe("bench-plugin-01");
    const manifest = JSON.parse(
      readPlugin(root, "openclaw.plugin.json", pluginId ?? "missing"),
    ) as {
      providers?: string[];
    };
    const source = readPlugin(root, "index.cjs", pluginId ?? "missing");

    expect(manifest.providers).toEqual(["bench-catalog-stall"]);
    expect(source).toContain("api.registerProvider");
    expect(source).toContain("Date.now() + 2000");
  });

  it("builds a valid large plugin-model startup case", () => {
    const root = tempDirs.make("openclaw-large-plugin-model-bench-test-");
    const selectedCase = resolveBenchCase("largePluginModelConfig");
    const config = readConfig(root, selectedCase);
    const entries = Object.values(config.agents?.entries ?? {});
    const modelRefs = collectConfiguredModelRefs(config, { includeChannelModelOverrides: false });

    expect(selectedCase.completionTracePhase).toBe("config.snapshot.auto-enable");
    expect(validateConfigObject(config).ok).toBe(true);
    expect(entries).toHaveLength(256);
    expect(modelRefs).toHaveLength(256 * 58);
    expect(new Set(modelRefs.map(({ value }) => value.slice(0, value.indexOf("/"))))).toEqual(
      new Set(["openai", "google", "minimax"]),
    );
    expect(config.plugins?.allow).toEqual(["openai", "google", "minimax"]);
  });

  it.each([false, true])(
    "builds the opt-in eight-agent boot case with 44 plugins (bundled fixture=%s)",
    (withBundledFixture) => {
      expect(testing.parseOptions([]).cases.some((entry) => entry.id === "teamBoot")).toBe(false);
      const root = tempDirs.make("openclaw-team-boot-config-test-");
      const bundledPluginFixture: OpenClawConfig = withBundledFixture
        ? {
            plugins: {
              allow: ["fixture-required", "fixture-defaults"],
              entries: {
                "fixture-required": {
                  config: { token: "synthetic-only", scheduler: { enabled: false } },
                },
              },
            },
            models: {
              providers: {
                "fixture-provider": {
                  baseUrl: "http://127.0.0.1:1/v1",
                  models: [],
                  agentRuntime: { id: "fixture-runtime" },
                },
              },
            },
            tools: { web: { search: { provider: "fixture-search" } } },
            channels: { "fixture-channel": { enabled: true } },
          }
        : {};
      const bundledPluginIds = bundledPluginFixture.plugins?.allow ?? [];
      const fixturePath = path.join(root, "bundled-plugins.json");
      fs.writeFileSync(fixturePath, JSON.stringify(bundledPluginFixture));
      const benchCase = testing.parseOptions([
        "--case",
        "teamBoot",
        ...(withBundledFixture ? ["--bundled-plugin-fixture", fixturePath] : []),
      ]).cases[0]!;
      const config = readConfig(root, benchCase);
      expect(validateConfigObject(config)).toMatchObject({ ok: true });
      expect(Object.keys(config.agents?.entries ?? {})).toHaveLength(8);
      expect(config.plugins?.allow).toHaveLength(44);
      expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
      expect(config.cron?.enabled).toBe(false);
      expect(config.gateway?.auth).toEqual({
        mode: "token",
        token: "synthetic-startup-benchmark-token",
      });
      expect(config.models).toEqual(bundledPluginFixture.models);
      expect(config.channels).toEqual(bundledPluginFixture.channels);
      expect(config.tools).toEqual(bundledPluginFixture.tools);
      expect(config.plugins?.entries?.browser).toEqual({ enabled: false });
      expect(
        testing.parseOptions(["--case", "teamBoot"]).cases[0]?.bundledPluginFixture,
      ).toBeUndefined();
      for (const pluginId of config.plugins?.allow ?? []) {
        if (bundledPluginIds.includes(pluginId)) {
          expect(config.plugins?.entries?.[pluginId]).toEqual({
            ...bundledPluginFixture.plugins?.entries?.[pluginId],
            enabled: true,
          });
          expect(fs.existsSync(path.join(root, "plugins", pluginId))).toBe(false);
          continue;
        }
        const manifest = JSON.parse(readPlugin(root, "openclaw.plugin.json", pluginId));
        expect(manifest.activation).toEqual({ onStartup: true });
      }
      expect(fs.readdirSync(path.join(root, "plugins"))).toHaveLength(44 - bundledPluginIds.length);
    },
  );

  it.for([[], ["--case", "default"]])("rejects a bundled fixture outside teamBoot (%j)", (args) => {
    expect(() =>
      testing.parseOptions([...args, "--bundled-plugin-fixture", "plugins.json"]),
    ).toThrow("--bundled-plugin-fixture requires --case teamBoot only");
  });

  it.for([
    null,
    [],
    {},
    "invalid",
    { plugins: { allow: [""] } },
    { plugins: { allow: ["openai", "openai"] } },
    { plugins: { allow: ["openai"], entries: { openai: null } } },
    { plugins: { allow: ["openai"], load: { paths: ["/unrelated"] } } },
    { plugins: { allow: ["openai"] }, gateway: { auth: { mode: "none" } } },
    { plugins: { allow: Array.from({ length: 45 }, (_, index) => `plugin-${index}`) } },
  ])("rejects invalid bundled plugin configuration %j", (value) => {
    const root = tempDirs.make("openclaw-invalid-plugin-fixture-test-");
    const fixturePath = path.join(root, "plugins.json");
    fs.writeFileSync(fixturePath, JSON.stringify(value));
    expect(() =>
      testing.parseOptions(["--case", "teamBoot", "--bundled-plugin-fixture", fixturePath]),
    ).toThrow("--bundled-plugin-fixture");
  });

  it.each([
    { count: 44, includesRequested: true, valid: true },
    { count: 38, includesRequested: true, valid: false },
    { count: 44, includesRequested: false, valid: false },
  ])(
    "validates the loaded plugin inventory ($count, requested=$includesRequested)",
    ({ count, includesRequested, valid }) => {
      const ids = [
        includesRequested ? "required-plugin" : "unrequested-plugin",
        ...Array.from({ length: count - 1 }, (_, index) => `fixture-${index}`),
      ];
      const result = testing.summarizeCase(
        {
          id: "teamBoot",
          name: "mixed boot",
          config: {},
          pluginCount: 44,
          bundledPluginFixture: { plugins: { allow: ["required-plugin"] } },
        },
        [
          gatewaySample({
            exitCode: 0,
            httpListenLogLine: `[gateway] http server listening (${count} plugins: ${ids.join(", ")}; 0.1s)`,
          }),
        ],
      );
      expect(testing.collectResultFailures([result]).length === 0).toBe(valid);
    },
  );

  it.each([
    { id: "preparedRuntimeScaleOne", agentCount: 1, sharedCount: 1, owner: "main" },
    { id: "preparedRuntimeScaleMany", agentCount: 12, sharedCount: 11, owner: "agent-01" },
  ])(
    "builds valid $id config with its shared and distinct workspaces",
    ({ id, agentCount, sharedCount, owner }) => {
      const root = tempDirs.make("openclaw-bench-config-test-");
      const config = readConfig(root, resolveBenchCase(id));
      expect(validateConfigObject(config)).toMatchObject({ ok: true });
      expect(config.agents?.ownership).toBe("explicit");
      expect(config.agents?.defaults?.systemAgent?.agentId).toBe(owner);
      expect(config.agents?.defaults?.modelPolicy?.allow).toEqual([
        "bench-catalog-stall/bench-model",
      ]);
      expect(
        config.agents?.defaults?.models?.["bench-catalog-stall/bench-model"]?.agentRuntime,
      ).toEqual({
        id: "openclaw",
      });
      const agents = Object.values(config.agents?.entries ?? {});
      expect(agents).toHaveLength(agentCount);
      expect(new Set(agents.slice(0, sharedCount).map((agent) => agent.workspace)).size).toBe(1);
      if (agentCount > sharedCount) {
        expect(agents[sharedCount]?.workspace).not.toBe(agents[0]?.workspace);
      }
      const pluginId = config.plugins?.allow?.[0];
      const manifest = JSON.parse(
        readPlugin(root, "openclaw.plugin.json", pluginId ?? "missing"),
      ) as {
        modelCatalog?: unknown;
        providerCatalogEntry?: string;
        providers?: string[];
      };
      expect(manifest.providers).toEqual(["bench-catalog-stall"]);
      expect(manifest.providerCatalogEntry).toBe("./provider-discovery.cjs");
      expect(manifest.modelCatalog).toBeUndefined();
      expect(readPlugin(root, "provider-discovery.cjs")).toContain(
        "preparedRuntimeStaticCatalogCallCount",
      );
    },
  );
});
