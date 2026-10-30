import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  collectInstalledCpuProfile,
  prepareInstalledCpuProfile,
} from "../../scripts/lib/gateway-bench-installed-diagnostic.ts";
import { isProcessAlive } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const wsServerUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("ws/package.json")), "lib/websocket-server.js"),
).href;
const sourceSha = "1".repeat(40);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const absent = (file: string) => expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });

async function readEvents(file: string) {
  return (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const acknowledged = { acknowledgment: { accepted: true } };
const measurementIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
type Events = Awaited<ReturnType<typeof readEvents>>;
const eventsOf = (events: Events, type: string) => events.filter((event) => event.type === type);
function expectRequests(events: Events, index: number) {
  expect(
    eventsOf(events, "request")
      .filter((event) => event.index === index)
      .map((event) => event.method),
  ).toEqual(["connect", "status", "health"]);
}

async function expectLaunches(target: { events: string; stateRoot: string }, profiled: boolean[]) {
  const events = await readEvents(target.events);
  const starts = eventsOf(events, "start");
  expect(starts.map(({ index, home }) => ({ index, home }))).toEqual(
    profiled.map((_, index) => ({ index, home: target.stateRoot })),
  );
  expect(starts.map((event) => event.execArgv.includes("--cpu-prof"))).toEqual(profiled);
  expect(eventsOf(events, "stop")).toHaveLength(profiled.length);
  expect(eventsOf(events, "descendant").map((event) => event.listeners)).toEqual(
    profiled.map(() => 0),
  );
  return { events, starts };
}

function expectSettled(report: Awaited<ReturnType<typeof readJson>>, failed = false) {
  expect(report).toMatchObject({
    outcome: failed ? "failed" : "passed",
    outerSettlement: { beforeCleanup: "dead", joined: true, exitCode: failed ? 1 : 0 },
  });
  expect(report.after).toEqual(report.before);
}

async function fixture(
  mode: "healthy" | "rpc-error" | "established-rpc-error" | "lingering" | "hold-health" = "healthy",
  commit = sourceSha,
) {
  const root = tempDirs.make("openclaw-installed-benchmark-");
  const installRoot = path.join(root, "install");
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeJson(path.join(packageRoot, "package.json"), { name: "openclaw", version: "1.0.0" });
  await writeJson(path.join(packageRoot, "dist", "build-info.json"), { commit });
  const events = path.join(root, "events.jsonl");
  await fs.writeFile(
    path.join(packageRoot, "openclaw.mjs"),
    `
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fork, spawn } from "node:child_process";
import path from "node:path";
import WebSocketServer from ${JSON.stringify(wsServerUrl)};
const record = (event) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n");
if (process.argv.includes("--descendant")) {
  record({ type: "descendant", listeners: process.listenerCount("message") });
  process.disconnect();
} else {
  const home = process.env.OPENCLAW_HOME;
  const counter = path.join(home, "fixture-counter");
  const index = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(index + 1));
  record({ type: "start", index, home, execArgv: process.execArgv });
  if (process.execArgv.includes("--cpu-prof")) {
    function fixtureStartupCpuWork() {
      const until = performance.now() + 60;
      while (performance.now() < until) { Math.sqrt(performance.now()); }
    }
    fixtureStartupCpuWork();
    const consoleResults = [
      console.log("startup trace: fixture.cpu 60.0ms total=70.0ms start=5.0ms calls=2"),
      console.info("fixture console %s", "info"),
      console.debug("fixture console debug"),
      console.warn("fixture console warn"),
      console.error("fixture console error"),
    ];
    if (consoleResults.some((value) => value !== undefined)) throw new Error("console return changed");
    for (const stream of ["stdout", "stderr"]) {
      await new Promise((resolve, reject) => {
        const accepted = process[stream].write("fixture direct " + stream + "\\n", resolve);
        if (typeof accepted !== "boolean") reject(new Error("stream write return changed"));
      });
    }
  }
  const inherited = fork(process.argv[1], ["--descendant"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((resolve, reject) => { inherited.once("exit", resolve); inherited.once("error", reject); });
  const server = createServer((req, res) => {
    res.writeHead(req.method === "HEAD" && ["/healthz", "/readyz"].includes(req.url) ? 200 : 404);
    res.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws) => ws.on("message", (data) => {
    const request = JSON.parse(data.toString());
    record({ type: "request", index, method: request.method });
    if (${JSON.stringify(mode)} === "hold-health" && request.method === "health") {
      console.log("fixture-health-wait");
      console.error("fixture-health-diagnostic");
      return;
    }
    const ok = !((${JSON.stringify(mode)} === "rpc-error" || (${JSON.stringify(mode)} === "established-rpc-error" && index === 1)) && request.method === "health");
    ws.send(JSON.stringify({ type: "res", id: request.id, ok, payload: request.method === "health" ? { ok: true, plugins: { errors: 0, unavailable: 1 }, eventLoop: { degraded: false } } : { fixture: true }, ...(ok ? {} : { error: { message: "fixture rejection" } }) }));
  }));
  process.on("SIGINT", () => {
    sockets.close(() => server.close(() => {
      record({ type: "stop", index });
      if (${JSON.stringify(mode)} === "lingering") {
        const leaked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
        record({ type: "lingering", childPid: leaked.pid });
        leaked.unref();
      }
      process.exit(0);
    }));
  });
  server.listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
}
`,
  );
  const tarball = path.join(root, "fixture.tgz");
  const bytes = `synthetic package ${commit}; installation is fixture-owned`;
  await fs.writeFile(tarball, bytes);
  await writeJson(path.join(installRoot, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { openclaw: "file:../fixture.tgz" } },
      "node_modules/openclaw": {
        version: "1.0.0",
        resolved: "file:../fixture.tgz",
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
      "node_modules/fixture-dependency": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz",
        integrity: "sha512-synthetic-dependency",
        optional: true,
        os: ["win32"],
      },
    },
  });
  const input = path.join(root, "input.json");
  const stateRoot = path.join(root, "state");
  await writeJson(input, {
    sourceSha: commit,
    toolingSha: sourceSha,
    tarball,
    installRoot,
    stateRoot,
    candidate: {
      name: "openclaw",
      packageSourceSha: commit,
      version: "1.0.0",
      sha256: hash(bytes),
    },
    runtime: { version: process.version, sha256: hash(await fs.readFile(process.execPath)) },
    artifact: {
      id: 1,
      runId: 1,
      runAttempt: 1,
      workflowSha: sourceSha,
      digest: `sha256:${"2".repeat(64)}`,
    },
  });
  const output = path.join(root, "report.json");
  return { packageRoot, input, output, stateRoot, events };
}

async function comparisonFixture(mode: Parameters<typeof fixture>[0] = "healthy", paired = true) {
  const baseline = await fixture();
  if (!paired) {
    return { baseline, candidate: undefined };
  }
  const candidate = await fixture(mode, "3".repeat(40));
  await writeJson(baseline.input, {
    ...(await readJson(baseline.input)),
    comparison: await readJson(candidate.input),
  });
  return { baseline, candidate };
}

async function runFixture(
  target: Awaited<ReturnType<typeof fixture>>,
  signal: AbortSignal,
  onReady?: NonNullable<Parameters<typeof runNodeScript>[3]>["onReady"],
  extraArgs: string[] = [],
) {
  return await runNodeScript(
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/bench-gateway-startup.ts",
      "--installed-cohort",
      target.input,
      "--output",
      target.output,
      ...extraArgs,
    ],
    process.env,
    undefined,
    {
      signal,
      cwd: process.cwd(),
      executable: process.execPath,
      maxBuffer: 1024 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
      onReady,
    },
  );
}

it("retains signed profile samples and rejects malformed capture data", async () => {
  const root = tempDirs.make("openclaw-installed-profile-");
  const capture = await prepareInstalledCpuProfile(path.join(root, "result.json"), "fixture.mjs");
  const phase = (monotonicUs: number, performanceMs: number) => ({
    phase: "fixture",
    durationMs: 1,
    totalMs: 1,
    monotonicUs,
    performanceMs,
  });
  const attachment = {
    pid: process.pid,
    parentPid: process.pid,
    mainThread: true,
    threadId: 0,
    entry: capture.entry,
    execArgv: capture.nodeArgs,
    attachedMonotonicUs: 1_000_100,
    attachedPerformanceMs: 100,
    timeOrigin: 1,
    exitedMonotonicUs: 1_009_900,
    code: 0,
    phases: [phase(1_000_200, 101), phase(1_000_300, 102)],
    droppedPhases: 0,
    observerErrors: [],
  };
  await writeJson(capture.attachmentPath, attachment);
  const file = path.join(capture.directory, `CPU.20260918.000000.${process.pid}.0.001.cpuprofile`);
  const profile = {
    // Native profile timestamps have their own origin, independent of hrtime.
    startTime: 7_000_001_000_000,
    endTime: 7_000_001_010_000,
    nodes: [1, 2].map((id) => ({ id, callFrame: { functionName: "fixture" } })),
    samples: [1, 2, 1],
    timeDeltas: [1_000, -100, 2_000],
  };
  const raw = JSON.stringify(profile);
  await fs.writeFile(file, raw);
  const result = await collectInstalledCpuProfile(capture, process.pid);
  expect(result).toMatchObject({
    samples: 3,
    negativeTimeDeltas: 1,
    profiles: [expect.objectContaining({ sha256: hash(raw) })],
    clockDomains: {
      controller: { pid: process.pid, source: "process.hrtime.bigint", unit: "microseconds" },
      gateway: { pid: process.pid, source: "process.hrtime.bigint", unit: "microseconds" },
      nativeProfile: { origin: "runtime-defined", unit: "microseconds" },
      alignment: "not-established",
    },
  });
  expect(await fs.readFile(file, "utf8")).toBe(raw);
  for (const invalid of [
    { ...attachment, exitedMonotonicUs: attachment.attachedMonotonicUs - 1 },
    {
      ...attachment,
      phases: [{ ...attachment.phases[0], monotonicUs: attachment.exitedMonotonicUs + 1 }],
    },
    { ...attachment, phases: attachment.phases.toReversed() },
    {
      ...attachment,
      phases: [attachment.phases[0], { ...attachment.phases[1], performanceMs: 100.5 }],
    },
  ]) {
    await writeJson(capture.attachmentPath, invalid);
    await expect(collectInstalledCpuProfile(capture, process.pid)).rejects.toThrow(
      /monotonic|performance clock/u,
    );
  }
  await writeJson(capture.attachmentPath, attachment);
  await writeJson(file, { ...profile, samples: [1, 3, 1] });
  await expect(collectInstalledCpuProfile(capture, process.pid)).rejects.toThrow(
    "CPU sample references an unknown node",
  );
  await fs.writeFile(file, raw.replace("-100", "1e999"));
  await expect(collectInstalledCpuProfile(capture, process.pid)).rejects.toThrow("timeDeltas");
});

it.for(["healthy", "established-rpc-error"] as const)(
  "retains the established CPU profile and both settled launches with %s",
  async (mode, { signal }) => {
    const target = await fixture(mode);
    const result = await runFixture(target, signal, undefined, ["--installed-cpu-diagnostic"]);
    const failed = mode === "established-rpc-error";
    expect(result.status, JSON.stringify(result)).toBe(failed ? 1 : 0);
    const report = await readJson(target.output);
    expectSettled(report, failed);
    expect(report).toMatchObject({
      measurementMode: "cpu-diagnostic",
      establishedReadySummary: null,
      comparisonSummary: null,
    });
    expect(report.samples).toMatchObject([{ phase: "fresh" }, { phase: "established" }]);
    const { events, starts } = await expectLaunches(target, [false, true]);
    for (const sample of report.samples) {
      expect(sample).toMatchObject({
        outcome: failed && sample.index === 1 ? "failed" : "passed",
        observations: {
          stateBefore: { backupExists: false, configSha256: expect.any(String) },
          stateAfter: { backupExists: false },
          shutdown: acknowledged,
        },
      });
      expectRequests(events, sample.index);
    }
    const [fresh, established] = report.samples;
    expect(fresh.observations.cpuProfile).toBeUndefined();
    const capture = established.observations.cpuProfile;
    expect(established.observations.health.response.ok).toBe(!failed);
    expect(established.errors).toHaveLength(failed ? 1 : 0);
    for (const [stream, messages] of [
      ["stdout", ["fixture console info", "fixture console debug", "fixture direct stdout"]],
      ["stderr", ["fixture console warn", "fixture console error", "fixture direct stderr"]],
    ] as const) {
      expect(
        established[stream].split("\n").filter((line: string) => line.startsWith("fixture ")),
      ).toEqual(messages);
    }
    expect(capture.attachment).toMatchObject({
      pid: starts[1].pid,
      mainThread: true,
      threadId: 0,
      code: 0,
      droppedPhases: 0,
      observerErrors: [],
    });
    expect(capture.attachment.phases).toEqual([
      expect.objectContaining({ phase: "fixture.cpu", durationMs: 60, startMs: 5, calls: 2 }),
    ]);
    const profile = await readJson(path.join(capture.directory, capture.mainProfile));
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.nodes).toContainEqual(
      expect.objectContaining({
        callFrame: expect.objectContaining({ functionName: "fixtureStartupCpuWork" }),
      }),
    );
    expect(established.observations.stateBefore).toEqual(fresh.observations.stateAfter);
  },
);

it.for(["paired-cpu", "dependency-integrity", "pending-lifecycle"] as const)(
  "refuses %s before launching any installation",
  async (mode, { signal }) => {
    const { baseline, candidate } = await comparisonFixture(
      "healthy",
      mode !== "pending-lifecycle",
    );
    if (mode === "pending-lifecycle") {
      await fs.writeFile(path.join(baseline.packageRoot, ".openclaw-lifecycle-pending"), "pending");
    } else if (mode === "dependency-integrity") {
      const lockPath = path.join(candidate!.packageRoot, "..", "..", "package-lock.json");
      const lock = await readJson(lockPath);
      lock.packages["node_modules/fixture-dependency"].integrity = "changed";
      await writeJson(lockPath, lock);
    }
    const result = await runFixture(
      baseline,
      signal,
      undefined,
      mode === "paired-cpu" ? ["--installed-cpu-diagnostic"] : [],
    );
    expect(result.status, result.stderr).toBe(1);
    if (mode === "paired-cpu") {
      expect(result.stderr).toContain("CPU diagnostics require one installed package");
    } else {
      const report = await readJson(baseline.output);
      if (mode === "dependency-integrity") {
        expect(result.stderr).toContain("Installed dependency records differ");
        expect(report.samples).toHaveLength(18);
      } else {
        expect(report.outcome).toBe("failed");
      }
      expect(
        report.samples.every((sample: { outcome: string }) => sample.outcome === "not-run"),
      ).toBe(true);
    }
    for (const target of candidate ? [baseline, candidate] : [baseline]) {
      await absent(target.events);
    }
  },
);

it.for(["single", "paired"] as const)(
  "retains settled launches and state in a %s cohort",
  async (mode, { signal }) => {
    const { baseline, candidate } = await comparisonFixture("healthy", mode === "paired");
    const result = await runFixture(baseline, signal);
    const report = await readJson(baseline.output);
    expect(result.error).toBeUndefined();
    expect(result.status, JSON.stringify({ stderr: result.stderr, report })).toBe(0);
    expect(result.stdout).toContain('"name":"launch"');
    expect(result.stdout).toContain('"name":"health"');
    expectSettled(report);
    expect(report.outerSettlement.outcome).toBe("passed");
    if (candidate) {
      // A fresh pair followed by four established ABBA blocks.
      const pair = ["baseline", "candidate"];
      const expectedArms = [
        ...pair,
        ...Array.from({ length: 4 }, () => [...pair, ...pair.toReversed()]).flat(),
      ];
      expect(report.samples.map((sample: { arm: string }) => sample.arm)).toEqual(expectedArms);
      expect(report.comparison.after).toEqual(report.comparison.before);
      expect(report).toMatchObject({
        dependencyParity: { packages: 3 },
        establishedReadySummary: null,
      });
    } else {
      expect(report.samples).toHaveLength(9);
      expect(report.establishedReadySummary).not.toBeNull();
    }
    for (const [arm, target] of Object.entries({ baseline, ...(candidate ? { candidate } : {}) })) {
      const samples = candidate
        ? report.samples.filter((sample: { arm: string }) => sample.arm === arm)
        : report.samples;
      if (candidate) {
        expect(samples.map((sample: { armIndex: number }) => sample.armIndex)).toEqual(
          measurementIndexes,
        );
      }
      const { events } = await expectLaunches(
        target,
        measurementIndexes.map(() => false),
      );
      await absent(`${target.output}.profiles`);
      for (const [index, sample] of samples.entries()) {
        expect(sample).toMatchObject({
          phase: index === 0 ? "fresh" : "established",
          outcome: "passed",
          errors: [],
          observations: {
            status: { response: { ok: true } },
            shutdown: acknowledged,
            health: { response: { ok: true, payload: { ok: true, plugins: { unavailable: 1 } } } },
          },
        });
        if (!candidate) {
          expect(sample.index).toBe(index);
        }
        expectRequests(events, index);
      }
    }
  },
);

it("keeps failed fresh health and unrun slots without an established summary", async ({
  signal,
}) => {
  const target = await fixture("rpc-error");
  const result = await runFixture(target, signal);
  expect(result.status, result.stderr).toBe(1);
  const report = await readJson(target.output);
  expect(report).toMatchObject({ outcome: "failed", establishedReadySummary: null });
  expect(report.samples.map((sample: { outcome: string }) => sample.outcome)).toEqual([
    "failed",
    ...Array(8).fill("not-run"),
  ]);
  expect(report.samples[0].observations).toMatchObject({
    health: { response: { ok: false, error: { message: "fixture rejection" } } },
    shutdown: acknowledged,
  });
});

it("joins descendants and retains the canceled candidate arm", async ({ signal }) => {
  const { baseline: target } = await comparisonFixture("hold-health");
  const cancellation = new AbortController();
  const result = await runFixture(
    target,
    AbortSignal.any([signal, cancellation.signal]),
    (child, readOutput) => {
      const cancelWhenObserved = () => {
        const output = readOutput();
        if (
          output.stdout.includes("fixture-health-wait") &&
          output.stderr.includes("fixture-health-diagnostic")
        ) {
          cancellation.abort();
        }
      };
      child.stdout?.on("data", cancelWhenObserved);
      child.stderr?.on("data", cancelWhenObserved);
    },
  );
  expect(cancellation.signal.aborted, JSON.stringify(result)).toBe(true);
  expect(result.error).toBeDefined();
  expect(result.stdout).toContain("fixture-health-wait");
  expect(result.stderr).toContain("fixture-health-diagnostic");
  const observations = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("[gateway-startup-observation] "))
    .map((line) => JSON.parse(line.slice("[gateway-startup-observation] ".length)));
  const candidateObservation = (name: string) =>
    observations.find((item) => item.index === 1 && item.arm === "candidate" && item.name === name);
  expect(candidateObservation("readyz")).toMatchObject({ phase: "fresh", value: { status: 200 } });
  expect(candidateObservation("status")).toMatchObject({ value: { response: { ok: true } } });
  const launches = observations.filter((observation) => observation.name === "launch");
  expect(launches.map((launch) => launch.arm)).toEqual(["baseline", "candidate"]);
  for (const { value } of launches) {
    expect([value.pid, value.controllerPid].map((pid) => isProcessAlive(pid))).toEqual([
      false,
      false,
    ]);
  }
  const report = await readJson(target.output);
  expect(report.outcome).not.toBe("passed");
  expect(report.establishedReadySummary).toBeNull();
  expect(
    report.samples.slice(2).every((sample: { outcome: string }) => sample.outcome === "not-run"),
  ).toBe(true);
});

it.runIf(process.platform === "win32")(
  "does not treat forced outer Job cleanup as successful Gateway settlement",
  async ({ signal }) => {
    const target = await fixture("lingering");
    const result = await runFixture(target, signal);
    const report = await readJson(target.output);
    expect(result.status, JSON.stringify({ result, report })).toBe(1);
    expect(report).toMatchObject({
      outerSettlement: { beforeCleanup: "indeterminate" },
      outcome: "failed",
      establishedReadySummary: null,
    });
    const lingering = eventsOf(await readEvents(target.events), "lingering");
    expect(lingering).toHaveLength(9);
    for (const { childPid } of lingering) {
      expect(isProcessAlive(childPid)).toBe(false);
    }
  },
);
