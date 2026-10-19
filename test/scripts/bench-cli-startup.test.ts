import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { testing } from "../../scripts/bench-cli-startup.ts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnv } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const repoRoot = join(__dirname, "../..");
const testNodeExecPath = resolveTestNodeExecPath();
const benchmarkUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.benchCli);
const benchmarkArgs = resolveRuntimeWorkerArgv(benchmarkUrl, testNodeExecPath);

type CaseResult = Parameters<typeof testing.collectFailedSamples>[0]["cases"][number];
type CliSample = CaseResult["samples"][number];

const stats = (value: number) => ({ avg: value, p50: value, p95: value, min: value, max: value });

function cliSample(overrides: Partial<CliSample> = {}): CliSample {
  return { ms: 10, firstOutputMs: 5, maxRssMb: 50, exitCode: 0, signal: null, ...overrides };
}

const failures = (overrides: Partial<CaseResult> = {}, entry = "openclaw.mjs") =>
  testing.collectFailedSamples({
    entry,
    cases: [
      {
        id: "version",
        name: "--version",
        args: ["--version"],
        contract: null,
        samples: [cliSample()],
        summary: {
          sampleCount: 1,
          durationMs: stats(10),
          firstOutputMs: stats(5),
          maxRssMb: stats(50),
          exitSummary: "code:0x1",
        },
        ...overrides,
      },
    ],
  });

function runBenchmarkCli(
  args: string[],
  env = process.env,
  timeout?: number,
  runtimeArgs = benchmarkArgs,
) {
  return spawnSync(testNodeExecPath, [...runtimeArgs, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout,
  });
}

function sampleArgs(entry: string, caseId = "version") {
  return ["--entry", entry, "--case", caseId, "--runs", "1", "--warmup", "0", "--json"];
}

function expectCliRejection(args: string[], error: string) {
  const result = runBenchmarkCli(args);
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr.trim()).toBe(error);
  expect(result.stderr).not.toContain("Node.js");
  expect(result.stderr).not.toContain("\n    at ");
}

function transportEnv(root: string, prefix: string, env = {}) {
  return {
    ...process.env,
    OPENCLAW_BENCH_TRANSPORT_JSON: JSON.stringify({
      prefix: [testNodeExecPath, prefix],
      binary: testNodeExecPath,
      env: { HOME: root, PATH: process.env.PATH, ...env },
    }),
  };
}

const configFixture = (id: string) =>
  testing.buildConfigFixture({ id, name: id, args: [], presets: [] });

// Synchronous drivers lack child handles; SIGKILL still needs observed process extinction.
async function waitForBenchmarkExit(pid: number, signal: AbortSignal) {
  while (isProcessAlive(pid)) {
    await delay(5, undefined, { signal }).catch((cause: unknown) => {
      throw new Error(`process still alive: ${pid}`, { cause });
    });
  }
}

const memoryTempDirs = useAutoCleanupTempDirTracker(afterEach);

it("routes synthetic samples and their state through the explicit transport without runner environment", () => {
  const root = memoryTempDirs.make("openclaw-cli-transport-");
  const prefix = join(root, "transport.mjs");
  const entry = join(root, "entry.mjs");
  const calls = join(root, "calls.jsonl");
  const output = join(root, "report.json");
  writeFileSync(
    prefix,
    `import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
assert.equal(args.shift(), "/usr/bin/env");
assert.equal(args.shift(), "-C");
const cwd = args.shift();
assert.equal(cwd, ${JSON.stringify(root)});
assert.equal(args.shift(), "-i");
const env = {};
while (args[0]?.includes("=") && !args[0].startsWith("/")) {
  const value = args.shift(), index = value.indexOf("=");
  env[value.slice(0,index)] = value.slice(index+1);
}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,env})+"\\n");
if (args[0] === "/usr/bin/timeout") {
  assert.deepEqual(args.splice(0,4), ["/usr/bin/timeout","--signal=TERM","--kill-after=1s","5s"]);
}
const result = spawnSync(args[0],args.slice(1),{env,cwd,stdio:"inherit"});
process.exit(result.status ?? 99);
`,
  );
  writeFileSync(
    entry,
    `import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.env.SUT_FIXTURE,"yes");
assert.equal(process.env.RUNNER_PRIVATE_CANARY,undefined);
assert.equal(process.env.OPENCLAW_BENCH_TRANSPORT_JSON,undefined);
assert.equal(process.cwd(),${JSON.stringify(root)});
fs.writeFileSync(process.env.OPENCLAW_STATE_DIR+"/witness","sample");
console.log("fixture version");
`,
  );
  const result = runBenchmarkCli(
    [...sampleArgs(entry), "--timeout-ms", "5000", "--output", output],
    {
      ...transportEnv(root, prefix, { SUT_FIXTURE: "yes" }),
      RUNNER_PRIVATE_CANARY: "must-not-forward",
    },
    15_000,
  );
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  expect(report.primary.executionMode).toBe("transport");
  expect(report.primary.cases[0].samples).toMatchObject([{ exitCode: 0, signal: null }]);
  const invocations = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(invocations).toHaveLength(4);
  expect(invocations.filter((call) => call.args.includes("/usr/bin/timeout"))).toHaveLength(1);
  expect(invocations.every((call) => call.env.RUNNER_PRIVATE_CANARY === undefined)).toBe(true);
});

it("rejects transported runtime RSS before launching the SUT filesystem helper", () => {
  const root = memoryTempDirs.make("openclaw-cli-rss-transport-");
  const prefix = join(root, "transport.mjs");
  const witness = join(root, "prefix-launched");
  writeFileSync(
    prefix,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(witness)}, "launched");
throw new Error("SUT prefix must not launch");`,
  );
  const result = runBenchmarkCli(
    ["--runtime-rss", "--entry", join(root, "missing-entry.mjs")],
    transportEnv(root, prefix),
  );
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(existsSync(witness)).toBe(false);
  expect(result.stderr.trim()).toBe("Cross-user runtime RSS sampling is not supported");
});

it("selects the same runtime when its launcher exits first", () => {
  const tmpDir = memoryTempDirs.make("openclaw-cli-rss-parent-first-");
  const entryPath = join(tmpDir, "entry.mjs");
  writeFileSync(
    entryPath,
    `import { fork } from "node:child_process";
const runtime = process.env.FIXTURE_RUNTIME === "1";
const usage = process.resourceUsage();
process.resourceUsage = () => ({ ...usage, maxRSS: (runtime ? 32 : 64) * 1024 });
if (runtime) {
  process.once("disconnect", () => console.log("runtime ready"));
  process.send("ready");
} else {
  const child = fork(process.argv[1], process.argv.slice(2), {
    env: { ...process.env, FIXTURE_RUNTIME: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  child.once("message", () => process.exit(0));
}
`,
  );
  const result = runBenchmarkCli([...sampleArgs(entryPath, "health"), "--runtime-rss"]);
  expect(result.status, result.stderr).toBe(0);
  const sample = JSON.parse(result.stdout).primary.cases[0].samples[0];
  expect(sample.maxRssMb).toBe(32);
  const roles = sample.memory.processes.map((record: { role: string }) => record.role);
  expect(roles.toSorted()).toEqual(["launcher", "runtime"]);
});

it("rejects unknown CLI options before running benchmarks", () => {
  expectCliRejection(["--wat", "--help"], "Unknown argument: --wat");
});

it.each([
  [["--wat"], "Unknown argument: --wat"],
  [["--output", "-h"], "--output requires a value"],
  [["--case", "-h"], "--case requires a value"],
  [["--output", "one.json", "--output", "two.json"], "--output was provided more than once"],
] as const)("rejects invalid arguments %j", (args, error) => {
  expect(() => testing.validateCliArgs([...args])).toThrow(error);
});

it("rejects duplicate benchmark cases before running benchmarks", () => {
  expectCliRejection(["--case", "version", "--case", "version"], 'Duplicate --case "version"');
});

it.runIf(process.platform !== "win32")(
  "cleans timed-out benchmark process groups when the leader exits first",
  async ({ signal }) => {
    const tmpDir = memoryTempDirs.make("openclaw-cli-startup-timeout-group-");
    const entryPath = join(tmpDir, "entry.mjs");
    const leaderPidPath = join(tmpDir, "leader.pid");
    const childPidPath = join(tmpDir, "child.pid");
    const childTermPath = join(tmpDir, "child-term.pid");
    try {
      writeFileSync(
        entryPath,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(childTermPath)}, String(process.pid)));
writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      // Keep real processes, but advance deadlines only after child-owned readiness.
      // The driver isolates Node mock timers from Vitest and the fixture processes.
      const result = runBenchmarkCli(
        [
          "--input-type=module",
          "-e",
          `import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isProcessAlive, waitForPidFile } from ${JSON.stringify(resolveRuntimeWorkerUrl(toolingTsEntrypoints.processWait).href)};
const realDelay = delay;
// The parent's synchronous 8 s hang guard cannot deliver Vitest's signal into this driver.
const PROCESS_WITNESS_HANG_GUARD_MS = 8_000;
mock.timers.enable({ apis: ["setTimeout", "Date"] });
try {
  const benchmark = import(pathToFileURL(process.argv[1]).href);
  const leader = await waitForPidFile(${JSON.stringify(leaderPidPath)}, AbortSignal.timeout(PROCESS_WITNESS_HANG_GUARD_MS), realDelay);
  const child = await waitForPidFile(${JSON.stringify(childPidPath)}, AbortSignal.timeout(PROCESS_WITNESS_HANG_GUARD_MS), realDelay);
  assert(isProcessAlive(leader), "leader must be alive before timeout");
  assert(isProcessAlive(child), "descendant must be ready before timeout");
  mock.timers.tick(100);
  while (isProcessAlive(leader)) await realDelay(5);
  assert.equal(await waitForPidFile(${JSON.stringify(childTermPath)}, AbortSignal.timeout(PROCESS_WITNESS_HANG_GUARD_MS), realDelay), child);
  assert(isProcessAlive(child), "descendant must outlive its leader");
  mock.timers.tick(50);
  while (isProcessAlive(child)) await realDelay(5);
  // Drain cleanup waits only after the OS has consumed SIGKILL.
  mock.timers.runAll();
  await benchmark;
} catch (error) {
  console.error(error);
  process.exit(2);
} finally {
  mock.timers.reset();
}
`,
          fileURLToPath(benchmarkUrl),
          ...sampleArgs(entryPath),
          "--timeout-ms",
          "100",
        ],
        {
          ...process.env,
          HOME: tmpDir,
          OPENCLAW_STATE_DIR: join(tmpDir, ".openclaw"),
          OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "50",
          VITEST: "1",
        },
        8_000,
        benchmarkArgs.slice(0, -1),
      );

      const outcome = [result.error, result.status, result.signal];
      expect(outcome, result.stderr).toEqual([undefined, 1, null]);
      expect(result.stderr).toContain("version sample 1: timed out");
      expect(JSON.parse(result.stdout).primary.cases[0].samples).toMatchObject([
        { timedOut: true, exitCode: 0, signal: null },
      ]);
      expect(isProcessAlive(Number(readFileSync(leaderPidPath, "utf8")))).toBe(false);
      expect(isProcessAlive(Number(readFileSync(childPidPath, "utf8")))).toBe(false);
    } finally {
      // The leader registers before spawning: failures before child readiness still
      // leave a known group to kill, including an unregistered descendant.
      if (existsSync(leaderPidPath)) {
        const leader = Number(readFileSync(leaderPidPath, "utf8"));
        forceKillVitestProcessGroup({ pid: leader });
        await waitForBenchmarkExit(leader, signal);
      }
      if (existsSync(childPidPath)) {
        await waitForBenchmarkExit(Number(readFileSync(childPidPath, "utf8")), signal);
      }
    }
  },
);

it.each<[Partial<CaseResult>, string[], string?]>([
  [{ samples: [] }, [": no measured samples"]],
  [
    {
      id: "gatewayStatusJson",
      samples: [
        cliSample(),
        cliSample({ exitCode: 1 }),
        cliSample({ exitCode: null, signal: "SIGTERM" }),
        cliSample({ timedOut: true }),
      ],
    },
    [
      " sample 2: exited with code 1",
      " sample 3: exited via signal SIGTERM",
      " sample 4: timed out",
    ],
    "dist/entry.js",
  ],
  [
    {
      id: "gatewayHealthJsonWarmState",
      warmupSamples: [cliSample({ exitCode: 1 })],
    },
    [" warmup 1: exited with code 1"],
    "dist/entry.js",
  ],
  [{ samples: [cliSample({ maxRssMb: null })] }, [" sample 1: did not report max RSS"]],
  [
    {
      id: "health",
      expectedExitCodes: [0, 1],
      expectedNonzeroOutputIncludes: ["Gateway target:"],
      samples: [cliSample({ exitCode: 1, stderrTail: "TypeError: crashed before output" })],
    },
    [
      " sample 1: exited with expected code 1 but output did not match expected clean-state markers (Gateway target:)",
    ],
  ],
])("reports failures for %j", (overrides, expected, entry = "openclaw.mjs") => {
  const label = `${entry} ${overrides.id ?? "version"}`;
  expect(failures(overrides, entry)).toEqual(expected.map((suffix) => label + suffix));
});

it("rejects invalid measured run counts", () => {
  for (const value of ["0", "2abc", "1.5", "1e3", "0x10"]) {
    expect(() => testing.parsePositiveInt(value, 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
  }
  expect(testing.parsePositiveInt("1", 5)).toBe(1);
  expect(testing.parseNonNegativeInt("0", 1)).toBe(0);
  for (const value of ["-1", "0b10"]) {
    expect(() => testing.parseNonNegativeInt(value, 1, "--warmup")).toThrow(
      "--warmup must be an integer >= 0",
    );
  }
});

it.each([
  ["none", ["configGetGatewayPort", "gatewayHealthJson", "health", "healthJson"]],
  ["token", ["gatewayHealthJsonWarmState", "gatewayHealthJsonFreshState"]],
] as const)("writes %s-auth config fixtures", (mode, ids) => {
  for (const id of ids) {
    expect(withEnv({ OPENCLAW_GATEWAY_PORT: undefined }, () => configFixture(id))).toEqual({
      gateway: { auth: { mode }, bind: "loopback", mode: "local", port: 32123 },
    });
  }
});

it("parses config fixture gateway ports strictly from env", () => {
  expect(testing.parseGatewayPortEnv(undefined)).toBe(32123);
  expect(testing.parseGatewayPortEnv("127.0.0.1:45678")).toBe(45678);
  expect(testing.parseGatewayPortEnv("[::1]:45679")).toBe(45679);
  expect(testing.parseGatewayPortEnv("::1")).toBe(32123);
  expect(testing.parseGatewayPortEnv("[::1]")).toBe(32123);

  for (const id of [
    "gatewayHealthJson",
    "gatewayHealthJsonWarmState",
    "gatewayHealthJsonFreshState",
  ]) {
    expect(withEnv({ OPENCLAW_GATEWAY_PORT: "45678" }, () => configFixture(id))).toMatchObject({
      gateway: { port: 45678 },
    });
  }

  for (const invalid of ["45678abc", "127.0.0.1:45678abc"]) {
    expect(() =>
      withEnv({ OPENCLAW_GATEWAY_PORT: invalid }, () => configFixture("gatewayHealthJson")),
    ).toThrow("OPENCLAW_GATEWAY_PORT must be an integer >= 1");
  }
});
