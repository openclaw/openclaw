import fs from "node:fs";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { afterEach, expect, it } from "vitest";
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
const readText = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const readJson = <T>(...parts: string[]): T => JSON.parse(readText(...parts));
type FixtureManifest = {
  activation?: { onStartup?: boolean };
  providers?: string[];
  modelCatalog?: unknown;
  providerCatalogEntry?: string;
};
const readManifest = (root: string, id = "bench-plugin-01") =>
  readJson<FixtureManifest>(root, "plugins", id, "openclaw.plugin.json");

function requireCase(id: string) {
  const result = testing.parseOptions(["--case", id]).cases[0];
  if (!result) {
    throw new Error(`expected benchmark case ${id}`);
  }
  return result;
}

function writeCase(id: string, overrides: Partial<Parameters<typeof testing.writeConfig>[1]> = {}) {
  const root = tempDirs.make("openclaw-bench-config-test-");
  const selected = { ...requireCase(id), ...overrides };
  const config = readJson<OpenClawConfig>(testing.writeConfig(root, selected));
  return { root, benchCase: selected, config };
}

function expectOptionsErrors(cases: Record<string, string>) {
  for (const [args, message] of Object.entries(cases)) {
    expect(() => testing.parseOptions(args.split(" "))).toThrow(message);
  }
}

function optionArgs(options: Record<string, string | number | true>) {
  return Object.entries(options).flatMap(([flag, value]) =>
    value === true ? [`--${flag}`] : [`--${flag}`, String(value)],
  );
}

function expectFailures(
  result: ReturnType<typeof summarizeSample>,
  reasons: string[],
  id = "demo",
  sampleIndex = 1,
) {
  expect(testing.collectResultFailures([result])).toEqual(
    reasons.map((reason) => ({ id, reason, sampleIndex })),
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

function summarizeSample(overrides: Partial<GatewaySample>, id = "demo", name = id) {
  const sample: GatewaySample = {
    completionMs: 20,
    cpuCoreRatio: 0.5,
    cpuMs: 100,
    exitCode: null,
    firstOutputMs: 1,
    gatewayReadyLogLine: "[gateway] ready",
    gatewayReadyLogMs: 20,
    healthz: startupProbe(10, "econnrefused"),
    httpListenLogLine: "[gateway] http server listening (0 plugins)",
    httpListenLogMs: 5,
    maxRssMb: 120,
    outputTail: "",
    readyz: startupProbe(18, "http-503"),
    signal: null,
    startupTrace: {},
    ...overrides,
  };
  return testing.summarizeCase({ config: {}, id, name }, [sample]);
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

// Strict managed process-group verification is not supported on Windows.
it.skipIf(process.platform === "win32")(
  "reports fractional counts without time units through the benchmark CLI",
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
    };
    const readEvents = (): FixtureEvent[] =>
      fs.existsSync(eventsPath)
        ? readText(eventsPath)
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    try {
      fs.writeFileSync(
        entry,
        `import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const record = (phase, extra = {}) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ phase, pid: process.pid, ...extra }) + "\\n");
const sample = (existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, JSON.stringify(sample));
record("started", { home: process.env.OPENCLAW_HOME });
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((req, res) => {
  const status = req.method === "HEAD" && ["/healthz", "/readyz"].includes(req.url) ? 200 : 404;
  record("probe", { method: req.method, status, path: req.url });
  res.writeHead(status, { connection: "close" });
  res.end();
});
let stopping = false;
const stop = (reason) => {
  if (stopping) return;
  stopping = true;
  server.close(() => { record("closed", { reason }); process.exit(0); });
};
process.on("SIGTERM", () => stop("signal"));
// The CLI owns stdin; EOF retires this detached fixture when the CLI is cancelled.
process.stdin.on("end", () => stop("stdin-eof"));
process.stdin.resume();
server.listen(port, "127.0.0.1", () => {
  console.log("[gateway] http server listening (0 plugins, 0.0s)");
  console.log("[gateway] ready (0 plugins, 0.0s)");
  console.log("startup trace: sidecars.model-runtime-build agentCount=" + (10 + sample) + " workspaceGroupCount=" + sample + " workspaceFactsMs=2.5");
  console.log("startup trace: memory.ready rssMb=32.5 heapUsedMb=16.25 externalMb=2");
});
`,
      );
      const result = await runNodeScript(
        [
          "--import",
          "tsx",
          "scripts/bench-gateway-startup.ts",
          ...optionArgs({ entry, case: "default", runs: 2, warmup: 0, output: reportPath }),
        ],
        { ...process.env, TMPDIR: root },
        undefined,
        { cwd: process.cwd(), signal, maxBuffer: 1024 * 1024, requireProcessTreeExit: true },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const events = readEvents();
      const started = events.filter((event) => event.phase === "started");
      expect(started).toHaveLength(2);
      expect(events.filter((event) => event.phase === "closed")).toHaveLength(2);
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
      }
      const report = JSON.parse(readText(reportPath));
      expect(report.results).toHaveLength(1);
      expect(report.results[0].samples).toHaveLength(2);
      const stats = (min: number, max: number) => ({
        min,
        max,
        p50: (min + max) / 2,
        avg: (min + max) / 2,
      });
      expect(report.results[0].summary.startupTrace).toMatchObject({
        "sidecars.model-runtime-build.agentCount": stats(11, 12),
        "sidecars.model-runtime-build.workspaceGroupCount": stats(1, 2),
        "sidecars.model-runtime-build.workspaceFactsMs": { p50: 2.5, avg: 2.5 },
      });
      expect(result.stdout).toContain("workspaceFacts=p50=2.5ms");
      expect(result.stdout).toContain("ready memory: rss=p50=32.5MB");
      expect(result.stdout).toContain("runtimePlugins=n/a");
      expect(result.stdout).toMatch(
        / {2}CPU core:\s+p50=\d+\.\d{3} avg=\d+\.\d{3} min=\d+\.\d{3} max=\d+\.\d{3}/u,
      );
      const counts = result.stdout
        .split("\n")
        .find((line) => line.startsWith("  prepared runtime:"));
      expect(counts).toContain("agents=p50=11.5 avg=11.5 min=11 max=12");
      expect(counts).toContain("workspaces=p50=1.5 avg=1.5 min=1 max=2");
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

it("rejects ambiguous benchmark CLI values before spawning Node", () => {
  expectOptionsErrors({
    "--wat": "Unknown argument: --wat",
    "--installed-cpu-diagnostic": "--installed-cpu-diagnostic requires --installed-cohort",
    "--output --case default": "--output requires a value",
    "--case": "--case requires a value",
    "--runs --warmup 0": "--runs requires a value",
    "--case default --case default": 'Duplicate --case "default"',
    "--output first.json --output second.json": "--output was provided more than once",
  });
  for (const flag of ["--cpu-prof-dir", "--heap-prof-dir", "--gateway-runtime", "--gateway-cpus"]) {
    expectOptionsErrors({
      [`--installed-cohort input.json --output result.json ${flag} profiles`]: `${flag} is not supported with --installed-cohort`,
    });
  }
  expect(
    testing.parseOptions(
      optionArgs({
        case: "default",
        output: "startup.json",
        json: true,
        "heap-prof-dir": "profiles",
        runs: 2,
      }),
    ),
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
  expectOptionsErrors({
    "--gateway-cpus 0-1": "--gateway-cpus",
    "--gateway-runtime bun\0": "--gateway-runtime",
    "--gateway-runtime bun --gateway-runtime node": "--gateway-runtime was provided more than once",
  });
});

it("forces incident packaged-plugin cases to load built plugin entries", () => {
  const env = createGatewayBenchEnv("/tmp/openclaw-bench", "/tmp/openclaw-bench/config.json", {
    caseEnv: requireCase("incidentCombined").env,
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
  const result = summarizeSample({
    completionMs: null,
    cpuCoreRatio: null,
    cpuMs: null,
    healthz: startupProbe(null, "econnrefused"),
    maxRssMb: null,
    readyz: startupProbe(null, "econnrefused"),
  });

  expect(result.summary.startupTrace).toEqual({});
  expectFailures(result, ["missing /healthz, /readyz, completion, cpu, rss"]);
});

it.each([
  { exitCode: 1, signal: null, reason: "child exited 1" },
  { exitCode: null, signal: "SIGSEGV", reason: "child exited by SIGSEGV" },
])("flags ready samples when $reason", ({ exitCode, signal, reason }) => {
  const result = summarizeSample({ exitedBeforeTeardown: true, exitCode, signal });
  expect(result.summary).toMatchObject({
    httpListenLogMs: { p50: 5 },
    gatewayReadyLogMs: { p50: 20 },
  });
  expect("readyLogMs" in result.summary).toBe(false);
  expectFailures(result, [reason]);
});

it("enforces the combined incident readiness budgets", () => {
  const result = summarizeSample(
    {
      completionMs: 60_000,
      exitCode: 0,
      gatewayReadyLogMs: 60_000,
      healthz: startupProbe(30_000),
      readyz: startupProbe(60_000),
    },
    "incidentCombined",
    "incident",
  );

  expectFailures(
    result,
    [
      "/healthz p95 30000.0ms must be under 30000.0ms",
      "/readyz p95 60000.0ms must be under 60000.0ms",
    ],
    "incidentCombined",
    0,
  );
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

    expect(result).toMatchObject({
      status: 200,
      ms: expect.any(Number),
      firstErrorKind: "http-503",
      firstRecoveryMs: expect.any(Number),
    });
    expect(result.transitions.map((transition) => transition.status)).toEqual([503, 200]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it("writes 50-plugin fixtures as a parent load path with explicit startup activation", () => {
  const { root, config } = writeCase("fiftyPlugins", { config: {}, pluginCount: 2 });
  expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
  expect(config.plugins?.allow).toEqual(["bench-plugin-01", "bench-plugin-02"]);
  expect(readManifest(root).activation?.onStartup).toBe(true);
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
  const inspectDatabase = (
    relativePath: string,
    inspect?: (db: InstanceType<typeof DatabaseSync>) => void,
  ) => {
    const db = new DatabaseSync(path.join(root, relativePath), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ app_version: null });
      inspect?.(db);
    } finally {
      db.close();
    }
  };
  inspectDatabase("state/state/openclaw.sqlite", (db) => {
    expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
      count: 1_000,
    });
    expect(db.prepare("PRAGMA freelist_count").get()?.freelist_count).toBeGreaterThan(0);
  });
  for (let index = 1; index <= 8; index += 1) {
    const id = String(index).padStart(2, "0");
    inspectDatabase(`state/agents/incident-agent-${id}/agent/openclaw-agent.sqlite`);
  }
  expect(
    fs.statSync(
      path.join(root, "workspaces/agent-01/incident-artifacts/batch-000/artifact-000000.bin"),
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
  const { root, config } = writeCase("preparedRuntimeCatalogStall");
  expect(config.agents?.defaults?.modelPolicy?.allow).toEqual(["bench-catalog-stall/bench-model"]);
  expect(validateConfigObject(config)).toMatchObject({ ok: true });
  expect(config.plugins?.allow?.[0]).toBe("bench-plugin-01");
  const source = readText(root, "plugins", "bench-plugin-01", "index.cjs");
  expect(readManifest(root).providers).toEqual(["bench-catalog-stall"]);
  expect(source).toContain("api.registerProvider");
  expect(source).toContain("Date.now() + 2000");
});

it("builds a valid large plugin-model startup case", () => {
  const { benchCase, config } = writeCase("largePluginModelConfig");
  const entries = Object.values(config.agents?.entries ?? {});
  const modelRefs = collectConfiguredModelRefs(config, { includeChannelModelOverrides: false });

  expect(benchCase.completionTracePhase).toBe("config.snapshot.auto-enable");
  expect(validateConfigObject(config).ok).toBe(true);
  expect(entries).toHaveLength(256);
  expect(modelRefs).toHaveLength(256 * 58);
  expect(new Set(modelRefs.map(({ value }) => value.slice(0, value.indexOf("/"))))).toEqual(
    new Set(["openai", "google", "minimax"]),
  );
  expect(config.plugins?.allow).toEqual(["openai", "google", "minimax"]);
});

it.each([
  { id: "preparedRuntimeScaleOne", agentCount: 1, sharedCount: 1, owner: "main" },
  { id: "preparedRuntimeScaleMany", agentCount: 12, sharedCount: 11, owner: "agent-01" },
])(
  "builds valid $id config with its shared and distinct workspaces",
  ({ id, agentCount, sharedCount, owner }) => {
    const { root, config } = writeCase(id);
    expect(validateConfigObject(config)).toMatchObject({ ok: true });
    expect(config.agents?.ownership).toBe("explicit");
    expect(config.agents?.defaults?.systemAgent?.agentId).toBe(owner);
    const defaults = config.agents?.defaults;
    expect(defaults?.modelPolicy?.allow).toEqual(["bench-catalog-stall/bench-model"]);
    expect(defaults?.models?.["bench-catalog-stall/bench-model"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    const agents = Object.values(config.agents?.entries ?? {});
    expect(agents).toHaveLength(agentCount);
    expect(new Set(agents.slice(0, sharedCount).map((agent) => agent.workspace)).size).toBe(1);
    if (agentCount > sharedCount) {
      expect(agents[sharedCount]?.workspace).not.toBe(agents[0]?.workspace);
    }
    const pluginId = config.plugins?.allow?.[0];
    const manifest = readManifest(root, pluginId ?? "missing");
    expect(manifest.providers).toEqual(["bench-catalog-stall"]);
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.cjs");
    expect(manifest.modelCatalog).toBeUndefined();
    expect(readText(root, "plugins", "bench-plugin-01", "provider-discovery.cjs")).toContain(
      "preparedRuntimeStaticCatalogCallCount",
    );
  },
);
