import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import bunPin from "../../scripts/lib/openclaw-bun.json" with { type: "json" };
import {
  buildTestLiveEnv,
  buildTestLiveVitestArgs,
  parseTestLiveArgs,
  resolveTestLiveHeartbeatMs,
} from "../../scripts/test-live.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import {
  isProcessAlive,
  waitForClose,
  waitForProcessExit,
} from "./live-process-fixture.test-support.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

describe("scripts/test-live", () => {
  posixIt.for([
    { runtime: "node", exitCode: 0 },
    { runtime: "node", exitCode: 7 },
    { runtime: "bun", exitCode: 0 },
    { runtime: "bun", exitCode: 7 },
    { runtime: undefined, exitCode: 0 },
  ])(
    "runs the cache package lane through $runtime and preserves exit $exitCode",
    ({ runtime, exitCode }, { signal }) =>
      fixtureLifetime.run(async () => {
        const root = fixtureLifetime.createTempDir("openclaw-cache-runtime-");
        const home = join(root, "home");
        const tmp = join(root, "tmp");
        for (const dir of [home, tmp]) {
          mkdirSync(dir);
        }
        const receipt = join(root, "invocation.json");
        const preload = join(root, "cache-preload.mjs");
        // Intercept both old and new leaf entrypoints before any provider code loads.
        writeFileSync(
          preload,
          `import fs from "node:fs";
import path from "node:path";
const bootstrap = path.basename(process.argv[1] ?? "") === "vitest-worker-bootstrap.mts";
if (bootstrap || ["check-live-cache.ts", "vitest.mjs"].includes(path.basename(process.argv[1] ?? ""))) {
  fs.writeFileSync(process.env.OPENCLAW_CACHE_RUNTIME_RECEIPT, JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node", args: process.argv.slice(bootstrap ? 4 : 2),
    live: process.env.OPENCLAW_LIVE_TEST, cache: process.env.OPENCLAW_LIVE_CACHE_TEST,
    selectedRuntime: process.env.OPENCLAW_VITEST_RUNTIME,
  }));
  process.exit(Number(process.env.OPENCLAW_FAKE_BUN_EXIT));
}`,
        );
        writeFakeBun(join(root, "bun"));
        const script = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:live:cache"];
        const [command, ...args] = script.split(/\s+/u);
        expect(command).toBe("node");
        expect(args.at(-1)).toMatch(
          /^(?:scripts\/check-live-cache\.ts|src\/agents\/live-cache-regression\.live\.test\.ts)$/u,
        );
        const result = await fixtureLifetime.track(
          runNodeScript(
            args,
            {
              PATH: `${root}:${process.env.PATH ?? ""}`,
              HOME: home,
              TMPDIR: tmp,
              TMP: tmp,
              TEMP: tmp,
              NODE_OPTIONS: `--import=${preload}`,
              OPENCLAW_VITEST_RUNTIME: runtime,
              CI: "",
              OPENCLAW_BUN_PATH: join(root, "bun"),
              OPENCLAW_CACHE_RUNTIME_RECEIPT: receipt,
              OPENCLAW_FAKE_BUN_EXIT: String(exitCode),
            },
            15_000,
            { cwd: process.cwd(), signal, requireProcessTreeExit: true, maxBuffer: 128 * 1024 },
          ),
        );
        expect(result, result.stderr).toMatchObject({ error: undefined, status: exitCode });
        const invocation = JSON.parse(readFileSync(receipt, "utf8"));
        expect(invocation).toMatchObject({
          runtime: runtime ?? "bun",
          selectedRuntime: runtime ?? "bun",
          live: "1",
          cache: "1",
        });
        expect(invocation.args).toContain("src/agents/live-cache-regression.live.test.ts");
      }),
  );

  it.each([
    [["--codex-harness", "--no-quiet"], ["x.live.test.ts", "--reporter=verbose"], true, "0"],
    [["--quiet"], ["--help", "--no-quiet", "--codex-harness"], false, "1"],
  ] as const)(
    "parses %j before -- and preserves %j after it",
    (flags, forwardedArgs, forceCodexHarness, quietOverride) => {
      const args = parseTestLiveArgs([...flags, "--", ...forwardedArgs]);
      expect(args).toEqual({ forceCodexHarness, quietOverride, forwardedArgs, help: false });
      expect(buildTestLiveVitestArgs(args)).toEqual([
        "run",
        "--config",
        "test/vitest/vitest.live.config.ts",
        ...forwardedArgs,
      ]);
    },
  );

  it("builds live env without mutating caller env", () => {
    expect(buildTestLiveEnv(parseTestLiveArgs(["--codex-harness"]), {})).toMatchObject({
      CI: "1",
      OPENCLAW_LIVE_CODEX_HARNESS: "1",
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_TEST_QUIET: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      pnpm_config_verify_deps_before_run: "false",
    });
  });

  posixIt.for(["SIGINT", "SIGTERM"] as const)(
    "selects Bun, signals its live child on %s and removes its joined namespace",
    (stopSignal, { signal }) =>
      withLiveFixture(signal, false, async ({ root, runner, completion }) => {
        const invocation = JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));
        expect(invocation).toMatchObject({ live: "1", quiet: "1", compileCache: "1" });
        expect(invocation.args).toEqual([
          "--tsconfig-override",
          join(process.cwd(), "tsconfig.json"),
          join(process.cwd(), "scripts/lib/vitest-worker-bootstrap.mts"),
          expect.stringContaining(join(process.cwd(), ".artifacts", "vitest-workers", "run-")),
          expect.stringMatching(/[/\\]vitest\.mjs$/),
          "run",
          "--config",
          "test/vitest/vitest.live.config.ts",
          "fake.live.test.ts",
        ]);

        expect(runner.pid).toBeGreaterThan(0);
        process.kill(runner.pid!, stopSignal);
        expect(await withinTest(completion, signal)).toEqual({ code: null, signal: stopSignal });
        expect(readFileSync(join(root, "signaled"), "utf8")).toBe(stopSignal);
        expect(existsSync(invocation.args[3])).toBe(false);
      }),
  );

  posixIt(
    "kills the selected live runtime process group after the no-output timeout",
    ({ signal }) =>
      withLiveFixture(signal, true, async ({ runner, completion, stderr }) => {
        runner.send("advance-watchdog");
        expect(await withinTest(completion, signal)).toEqual({ code: 1, signal: null });
        expect(Buffer.concat(stderr).toString("utf8")).toContain(
          "no output for 100ms; terminating stalled Vitest process group",
        );
        expect(Buffer.concat(stderr).toString("utf8")).toContain("[test:live] still running");
      }),
  );

  it("rejects loose heartbeat intervals instead of parsing prefixes", () => {
    expect(resolveTestLiveHeartbeatMs({})).toBe(20_000);
    expect(resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "2500" })).toBe(2500);
    for (const value of ["1e3", "1000ms", "0"]) {
      expect(() =>
        resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: value }),
      ).toThrow(`invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: ${value}`);
    }
  });

  it("prints help without spawning live Vitest", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-live.mts", "--help"],
      {
        encoding: "utf8",
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: node --import tsx scripts/test-live.mts");
    expect(result.stdout).not.toMatch(/Scope:|pnpm|\[test:live\]/u);
  });
});

function withLiveFixture(
  signal: AbortSignal,
  watchdog: boolean,
  check: (fixture: {
    root: string;
    runner: ReturnType<typeof spawn>;
    completion: ReturnType<typeof waitForClose>;
    stderr: Buffer[];
  }) => Promise<void>,
) {
  return fixtureLifetime.run(async () => {
    const root = fixtureLifetime.createTempDir("openclaw-test-live-");
    const fakeBunPath = join(root, "bun");
    writeFakeBun(fakeBunPath);
    // Advance the watchdog only after both real process-group signal handlers are ready.
    const args = watchdog
      ? [
          "--input-type=module",
          "--eval",
          `import { mock } from "node:test";
import { main } from "./scripts/test-live.mts";
mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
process.once("message", () => { mock.timers.tick(25); mock.timers.tick(75); });
main(["--", "fake.live.test.ts"]);`,
        ]
      : ["scripts/test-live.mts", "--", "fake.live.test.ts"];
    const runner = spawn(process.execPath, ["--import", "tsx", ...args], {
      env: {
        ...process.env,
        OPENCLAW_VITEST_RUNTIME: "bun",
        OPENCLAW_BUN_PATH: fakeBunPath,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        ...(watchdog
          ? {
              OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "25",
              OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "100",
            }
          : { OPENCLAW_FAKE_BUN_SIGNALED_PATH: join(root, "signaled") }),
      },
      stdio: watchdog ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "ignore"],
    });
    const completion = waitForClose(runner);
    const stderr: Buffer[] = [];
    runner.stderr?.on("data", (chunk) => stderr.push(chunk));
    let pids: number[] = [];
    try {
      pids = await waitForFixtureReady(runner, signal);
      await check({ root, runner, completion, stderr });
      for (const pid of pids) {
        await waitForProcessExit(pid, signal);
      }
      expect(existsSync(readFileSync(join(root, "namespace"), "utf8"))).toBe(false);
    } finally {
      await fixtureLifetime.verifyCleanup(() => stopFixture(runner, completion, pids));
    }
  });
}

function writeFakeBun(filePath: string): void {
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
if (process.argv[2] === "--revision") {
  process.stdout.write(${JSON.stringify(`${bunPin.revision}\n`)});
  process.exit(0);
}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");
const env = process.env;
fs.writeFileSync(join(__dirname, "invocation.json"), JSON.stringify({
  runtime: "bun", args: process.argv.slice(2), live: env.OPENCLAW_LIVE_TEST,
  cache: env.OPENCLAW_LIVE_CACHE_TEST, selectedRuntime: env.OPENCLAW_VITEST_RUNTIME,
  quiet: env.OPENCLAW_LIVE_TEST_QUIET, compileCache: env.NODE_DISABLE_COMPILE_CACHE,
}));
if (env.OPENCLAW_FAKE_BUN_EXIT !== undefined) process.exit(Number(env.OPENCLAW_FAKE_BUN_EXIT));
const tmp = require("node:os").tmpdir();
fs.writeFileSync(join(__dirname, "namespace"), tmp);
fs.writeFileSync(join(tmp, "owned-marker"), "owned");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  fs.writeFileSync(env.OPENCLAW_FAKE_BUN_SIGNALED_PATH, signal);
  process.exit(0);
});
const child = spawn(process.execPath, ["-e",
  "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);"
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
// Readiness certifies both signal handlers, not merely spawned processes.
child.once("message", (pid) => process.stdout.write(\`\${process.pid} \${pid}\\n\`));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(filePath, 0o755);
}

async function waitForFixtureReady(runner: ReturnType<typeof spawn>, signal: AbortSignal) {
  if (!runner.stdout) {
    throw new Error("fixture readiness requires piped stdout");
  }
  signal.throwIfAborted();
  const lines = createInterface({ input: runner.stdout, signal });
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
    lines.close();
  };
  runner.once("error", onError);
  try {
    for await (const line of lines) {
      const pids = line.split(" ").map(Number);
      expect(pids).toHaveLength(2);
      for (const pid of pids) {
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
      }
      return pids;
    }
    throw spawnError ?? new Error("fixture closed before reporting readiness");
  } finally {
    runner.off("error", onError);
    lines.close();
  }
}

async function stopFixture(
  runner: ReturnType<typeof spawn>,
  completion: ReturnType<typeof waitForClose>,
  pids: number[],
) {
  try {
    if (runner.pid && isProcessAlive(runner.pid)) {
      runner.kill("SIGTERM");
    }
    await completion;
  } finally {
    for (const pid of [runner.pid, ...pids]) {
      if (pid && isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  }
}
