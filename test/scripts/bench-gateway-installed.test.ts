import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

async function fixture(
  mode: "healthy" | "rpc-error" | "established-rpc-error" | "lingering" | "hold-health" = "healthy",
  commit = sourceSha,
) {
  const root = tempDirs.make("openclaw-installed-benchmark-");
  const installRoot = path.join(root, "install");
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  await fs.writeFile(path.join(packageRoot, "dist", "build-info.json"), JSON.stringify({ commit }));
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
    console.log("startup trace: fixture.cpu 60.0ms total=70.0ms start=5.0ms calls=2");
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
  await fs.writeFile(tarball, `synthetic package ${commit}; installation is fixture-owned`);
  await fs.writeFile(
    path.join(installRoot, "package-lock.json"),
    JSON.stringify({
      name: "install",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: { openclaw: "file:../fixture.tgz" } },
        "node_modules/openclaw": {
          version: "1.0.0",
          resolved: "file:../fixture.tgz",
          integrity: `sha512-${createHash("sha512")
            .update(await fs.readFile(tarball))
            .digest("base64")}`,
        },
        "node_modules/fixture-dependency": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz",
          integrity: "sha512-synthetic-dependency",
          optional: true,
          os: ["win32"],
        },
      },
    }),
  );
  const input = path.join(root, "input.json");
  const stateRoot = path.join(root, "state");
  await fs.writeFile(
    input,
    JSON.stringify({
      sourceSha: commit,
      toolingSha: sourceSha,
      tarball,
      installRoot,
      stateRoot,
      candidate: {
        name: "openclaw",
        packageSourceSha: commit,
        version: "1.0.0",
        sha256: hash(await fs.readFile(tarball)),
      },
      runtime: { version: process.version, sha256: hash(await fs.readFile(process.execPath)) },
      artifact: {
        id: 1,
        runId: 1,
        runAttempt: 1,
        workflowSha: sourceSha,
        digest: `sha256:${"2".repeat(64)}`,
      },
    }),
  );
  const output = path.join(root, "report.json");
  return { root, packageRoot, input, output, stateRoot, events };
}

async function comparisonFixture(mode: Parameters<typeof fixture>[0] = "healthy") {
  const baseline = await fixture();
  const candidate = await fixture(mode, "3".repeat(40));
  await fs.writeFile(
    baseline.input,
    JSON.stringify({
      ...JSON.parse(await fs.readFile(baseline.input, "utf8")),
      comparison: JSON.parse(await fs.readFile(candidate.input, "utf8")),
    }),
  );
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

describe("installed Gateway startup benchmark entry", () => {
  it("retains signed profile samples and rejects malformed capture data", async () => {
    const root = tempDirs.make("openclaw-installed-profile-");
    const capture = await prepareInstalledCpuProfile(path.join(root, "result.json"), "fixture.mjs");
    await fs.writeFile(
      capture.attachmentPath,
      JSON.stringify({
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
        phases: [],
        droppedPhases: 0,
        observerErrors: [],
      }),
    );
    const file = path.join(
      capture.directory,
      `CPU.20260918.000000.${process.pid}.0.001.cpuprofile`,
    );
    const profile = {
      startTime: 1_000_000,
      endTime: 1_010_000,
      nodes: [
        { id: 1, callFrame: { functionName: "first" } },
        { id: 2, callFrame: { functionName: "second" } },
      ],
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
    });
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    await fs.writeFile(file, JSON.stringify({ ...profile, samples: [1, 3, 1] }));
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
      const report = JSON.parse(await fs.readFile(target.output, "utf8"));
      expect(report).toMatchObject({
        outcome: failed ? "failed" : "passed",
        measurementMode: "cpu-diagnostic",
        establishedReadySummary: null,
        comparisonSummary: null,
        outerSettlement: { beforeCleanup: "dead", joined: true, exitCode: failed ? 1 : 0 },
      });
      expect(report.after).toEqual(report.before);
      expect(report.samples.map((sample: { phase: string }) => sample.phase)).toEqual([
        "fresh",
        "established",
      ]);
      const events = (await fs.readFile(target.events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const starts = events.filter((event) => event.type === "start");
      expect(starts.map((event) => event.index)).toEqual([0, 1]);
      expect(starts.map((event) => event.home)).toEqual([target.stateRoot, target.stateRoot]);
      expect(starts.map((event) => event.execArgv.includes("--cpu-prof"))).toEqual([false, true]);
      expect(events.filter((event) => event.type === "stop")).toHaveLength(2);
      expect(
        events.filter((event) => event.type === "descendant").map((event) => event.listeners),
      ).toEqual([0, 0]);
      for (const sample of report.samples) {
        expect(sample).toMatchObject({
          outcome: failed && sample.index === 1 ? "failed" : "passed",
          observations: {
            stateBefore: { backupExists: false, configSha256: expect.any(String) },
            stateAfter: { backupExists: false },
            shutdown: { acknowledgment: { accepted: true } },
          },
        });
        expect(
          events
            .filter((event) => event.type === "request" && event.index === sample.index)
            .map((event) => event.method),
        ).toEqual(["connect", "status", "health"]);
      }
      expect(report.samples[0].observations.cpuProfile).toBeUndefined();
      const capture = report.samples[1].observations.cpuProfile;
      expect(report.samples[1].observations.health.response.ok).toBe(!failed);
      expect(report.samples[1].errors.length).toBe(failed ? 1 : 0);
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
      const profile = JSON.parse(
        await fs.readFile(path.join(capture.directory, capture.mainProfile), "utf8"),
      );
      expect(profile.samples.length).toBeGreaterThan(0);
      expect(
        profile.nodes.some(
          (node: { callFrame: { functionName: string } }) =>
            node.callFrame.functionName === "fixtureStartupCpuWork",
        ),
      ).toBe(true);
      expect(report.samples[1].observations.stateBefore).toEqual(
        report.samples[0].observations.stateAfter,
      );
    },
  );

  it("refuses a paired CPU diagnostic before either installation launches", async ({ signal }) => {
    const { baseline, candidate } = await comparisonFixture();
    const result = await runFixture(baseline, signal, undefined, ["--installed-cpu-diagnostic"]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("CPU diagnostics require one installed package");
    for (const target of [baseline, candidate]) {
      await expect(fs.access(target.events)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("compares alternating pairs with independent retained state and complete first requests", async ({
    signal,
  }) => {
    const { baseline, candidate } = await comparisonFixture();
    const result = await runFixture(baseline, signal);
    const report = JSON.parse(await fs.readFile(baseline.output, "utf8"));
    expect(result.status, JSON.stringify({ result, report })).toBe(0);
    expect(report.outcome).toBe("passed");
    expect(report.samples.map((sample: { arm: string }) => sample.arm)).toEqual([
      "baseline",
      "candidate",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
    expect(report.after).toEqual(report.before);
    expect(report.comparison.after).toEqual(report.comparison.before);
    expect(report.dependencyParity.packages).toBe(3);
    expect(report.establishedReadySummary).toBeNull();
    for (const [arm, target] of [
      ["baseline", baseline],
      ["candidate", candidate],
    ] as const) {
      const samples = report.samples.filter((sample: { arm: string }) => sample.arm === arm);
      expect(samples.map((sample: { armIndex: number }) => sample.armIndex)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      const events = (await fs.readFile(target.events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "start").map((event) => event.index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(
        new Set(events.filter((event) => event.type === "start").map((event) => event.home)),
      ).toEqual(new Set([target.stateRoot]));
      expect(events.filter((event) => event.type === "stop")).toHaveLength(9);
      for (const sample of samples) {
        expect(sample).toMatchObject({
          outcome: "passed",
          errors: [],
          observations: {
            status: { response: { ok: true } },
            health: { response: { ok: true } },
            shutdown: { acknowledgment: { accepted: true } },
          },
        });
      }
    }
    expect(report.outerSettlement).toMatchObject({
      beforeCleanup: "dead",
      joined: true,
      exitCode: 0,
    });
  });

  it.for(["version", "integrity", "optional"])(
    "refuses dependency %s drift before either package starts",
    async (field, { signal }) => {
      const { baseline, candidate } = await comparisonFixture();
      const lockPath = path.join(candidate.packageRoot, "..", "..", "package-lock.json");
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      lock.packages["node_modules/fixture-dependency"][field] =
        field === "optional" ? false : "changed";
      await fs.writeFile(lockPath, JSON.stringify(lock));
      const result = await runFixture(baseline, signal);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Installed dependency records differ");
      const report = JSON.parse(await fs.readFile(baseline.output, "utf8"));
      expect(report.samples).toHaveLength(18);
      expect(
        report.samples.every((sample: { outcome: string }) => sample.outcome === "not-run"),
      ).toBe(true);
      for (const target of [baseline, candidate]) {
        await expect(fs.access(target.events)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("retains nine real launches, first RPCs and acknowledged exits in one state directory", async ({
    signal,
  }) => {
    const target = await fixture();
    const result = await runFixture(target, signal);
    const report = JSON.parse(await fs.readFile(target.output, "utf8"));
    expect(result.error).toBeUndefined();
    expect(result.status, JSON.stringify({ stderr: result.stderr, report })).toBe(0);
    expect(result.stdout).toContain('"name":"launch"');
    expect(result.stdout).toContain('"name":"health"');
    expect(report.outcome).toBe("passed");
    expect(report.outerSettlement).toMatchObject({
      beforeCleanup: "dead",
      exitCode: 0,
      joined: true,
      outcome: "passed",
    });
    expect(report.after).toEqual(report.before);
    expect(report.samples).toHaveLength(9);
    const events = (await fs.readFile(target.events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "start").map((event) => event.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      new Set(events.filter((event) => event.type === "start").map((event) => event.home)),
    ).toEqual(new Set([target.stateRoot]));
    expect(
      events.filter((event) => event.type === "descendant").map((event) => event.listeners),
    ).toEqual(Array(9).fill(0));
    expect(events.filter((event) => event.type === "stop")).toHaveLength(9);
    expect(
      events
        .filter((event) => event.type === "start")
        .every((event) => !event.execArgv.includes("--cpu-prof")),
    ).toBe(true);
    await expect(fs.access(`${target.output}.profiles`)).rejects.toMatchObject({ code: "ENOENT" });
    for (const [index, sample] of report.samples.entries()) {
      expect(sample).toMatchObject({
        index,
        phase: index === 0 ? "fresh" : "established",
        outcome: "passed",
        errors: [],
        observations: {
          shutdown: { acknowledgment: { accepted: true } },
          health: { response: { ok: true, payload: { ok: true, plugins: { unavailable: 1 } } } },
        },
      });
      expect(
        events
          .filter((event) => event.type === "request" && event.index === index)
          .map((event) => event.method),
      ).toEqual(["connect", "status", "health"]);
    }
    expect(report.establishedReadySummary).not.toBeNull();
  });

  it("retains a failed first request and all unrun slots without reporting an established summary", async ({
    signal,
  }) => {
    const target = await fixture("rpc-error");
    const result = await runFixture(target, signal);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(await fs.readFile(target.output, "utf8"));
    expect(report.samples[0], JSON.stringify({ stderr: result.stderr, report })).toMatchObject({
      observations: { health: { response: { ok: false } } },
    });
    expect(report.outcome).toBe("failed");
    expect(report.samples.map((sample: { outcome: string }) => sample.outcome)).toEqual([
      "failed",
      ...Array(8).fill("not-run"),
    ]);
    expect(report.samples[0].observations.health.response).toMatchObject({
      ok: false,
      error: { message: "fixture rejection" },
    });
    expect(report.samples[0].observations.shutdown.acknowledgment.accepted).toBe(true);
    expect(report.establishedReadySummary).toBeNull();
  });

  it("retains the active comparison arm and joins descendants when canceled during candidate health", async ({
    signal,
  }) => {
    const { baseline: target } = await comparisonFixture("hold-health");
    const cancellation = new AbortController();
    let observedHealthWait = false;
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
            observedHealthWait = true;
            cancellation.abort();
          }
        };
        child.stdout?.on("data", cancelWhenObserved);
        child.stderr?.on("data", cancelWhenObserved);
      },
    );
    expect(observedHealthWait, JSON.stringify(result)).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.stdout).toContain("fixture-health-wait");
    expect(result.stderr).toContain("fixture-health-diagnostic");
    const observations = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("[gateway-startup-observation] "))
      .map((line) => JSON.parse(line.slice("[gateway-startup-observation] ".length)));
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          index: 1,
          arm: "candidate",
          phase: "fresh",
          name: "readyz",
          value: expect.objectContaining({ status: 200 }),
        }),
        expect.objectContaining({
          index: 1,
          arm: "candidate",
          name: "status",
          value: expect.objectContaining({ response: expect.objectContaining({ ok: true }) }),
        }),
      ]),
    );
    const launches = observations.filter((observation) => observation.name === "launch");
    expect(launches.map((launch) => launch.arm)).toEqual(["baseline", "candidate"]);
    for (const launch of launches) {
      expect(isProcessAlive(launch.value.pid)).toBe(false);
      expect(isProcessAlive(launch.value.controllerPid)).toBe(false);
    }
    const report = JSON.parse(await fs.readFile(target.output, "utf8"));
    expect(report.outcome).not.toBe("passed");
    expect(report.establishedReadySummary).toBeNull();
    expect(
      report.samples.slice(2).every((sample: { outcome: string }) => sample.outcome === "not-run"),
    ).toBe(true);
  });

  it("refuses an unsettled normal installation before launching any sample", async ({ signal }) => {
    const target = await fixture();
    await fs.writeFile(path.join(target.packageRoot, ".openclaw-lifecycle-pending"), "pending");
    const result = await runFixture(target, signal);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(await fs.readFile(target.output, "utf8"));
    expect(report.outcome).toBe("failed");
    expect(
      report.samples.every((sample: { outcome: string }) => sample.outcome === "not-run"),
    ).toBe(true);
    await expect(fs.access(target.events)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")(
    "does not treat forced outer Job cleanup as successful Gateway settlement",
    async ({ signal }) => {
      const target = await fixture("lingering");
      const result = await runFixture(target, signal);
      const report = JSON.parse(await fs.readFile(target.output, "utf8"));
      expect(result.status, JSON.stringify({ result, report })).toBe(1);
      expect(report.outerSettlement.beforeCleanup).toBe("indeterminate");
      expect(report.outcome).toBe("failed");
      expect(report.establishedReadySummary).toBeNull();
      const lingering = (await fs.readFile(target.events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "lingering");
      expect(lingering).toHaveLength(9);
      for (const { childPid } of lingering) {
        expect(isProcessAlive(childPid)).toBe(false);
      }
    },
  );
});
