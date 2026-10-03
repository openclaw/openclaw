// Test Live tests cover test live script behavior.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTestLiveEnv,
  buildTestLiveVitestArgs,
  parseTestLiveArgs,
  resolveTestLiveHeartbeatMs,
} from "../../scripts/test-live.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { withinTest } from "../helpers/promise.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

describe("scripts/test-live", () => {
  it("parses wrapper flags before live test spawn", () => {
    const args = parseTestLiveArgs([
      "--codex-harness",
      "--no-quiet",
      "--",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);

    expect(args).toEqual({
      forceCodexHarness: true,
      forwardedArgs: ["src/gateway/gateway-codex-harness.live.test.ts", "--reporter=verbose"],
      help: false,
      quietOverride: "0",
    });
    expect(buildTestLiveVitestArgs(args)).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.live.config.ts",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);
  });

  it("preserves vitest flags after the passthrough separator", () => {
    const args = parseTestLiveArgs(["--quiet", "--", "--help", "--no-quiet", "--codex-harness"]);

    expect(args).toEqual({
      forceCodexHarness: false,
      forwardedArgs: ["--help", "--no-quiet", "--codex-harness"],
      help: false,
      quietOverride: "1",
    });
  });

  it("builds live env without mutating caller env", () => {
    const env = buildTestLiveEnv(
      { forceCodexHarness: true, forwardedArgs: [], help: false, quietOverride: undefined },
      {},
    );

    expect(env).toMatchObject({
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
      fixtureLifetime.run(async () => {
        const root = mkdtempSync(join(tmpdir(), "openclaw-test-live-signal-"));
        const fakeBunPath = join(root, "bun");
        const signaledPath = join(root, "signaled");

        writeFakeBun(fakeBunPath);
        const runner = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/test-live.mts", "--", "fake.live.test.ts"],
          {
            env: {
              ...process.env,
              OPENCLAW_FAKE_BUN_SIGNALED_PATH: signaledPath,
              OPENCLAW_VITEST_RUNTIME: "bun",
              PATH: `${root}:${process.env.PATH ?? ""}`,
            },
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        const completion = waitForClose(runner);
        let childPid = 0;
        let descendantPid = 0;

        try {
          ({ childPid, descendantPid } = await waitForFixtureReady(runner, signal));

          const invocation = JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));
          expect(invocation).toMatchObject({ live: "1", quiet: "1", compileCache: "1" });
          expect(invocation.args).toEqual([
            "--tsconfig-override",
            join(process.cwd(), "tsconfig.json"),
            expect.stringMatching(/[/\\]vitest\.mjs$/),
            "run",
            "--config",
            "test/vitest/vitest.live.config.ts",
            "fake.live.test.ts",
          ]);

          expect(runner.pid).toBeGreaterThan(0);
          process.kill(runner.pid!, stopSignal);
          const result = await withinTest(completion, signal);

          expect(result).toEqual({ code: null, signal: stopSignal });
          expect(readFileSync(signaledPath, "utf8")).toBe(stopSignal);
          await waitForProcessExit(childPid, signal);
          await waitForProcessExit(descendantPid, signal);
          expect(existsSync(readFileSync(join(root, "namespace"), "utf8"))).toBe(false);
        } finally {
          await stopFixture(runner, completion, [childPid, descendantPid]);
          rmSync(root, { force: true, recursive: true });
        }
      }),
  );

  posixIt(
    "kills the selected live runtime process group after the no-output timeout",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const root = mkdtempSync(join(tmpdir(), "openclaw-test-live-timeout-"));
        const fakeBunPath = join(root, "bun");
        const stderr: Buffer[] = [];

        writeFakeBun(fakeBunPath);
        // Advance the watchdog only after the real process group is ready; startup
        // latency must not race the short timeout that this test is exercising.
        const runner = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            [
              'import { mock } from "node:test";',
              'import { main } from "./scripts/test-live.mts";',
              'mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });',
              'process.once("message", () => {',
              "  mock.timers.tick(25);",
              "  mock.timers.tick(75);",
              "});",
              'main(["--", "fake.live.test.ts"]);',
            ].join("\n"),
          ],
          {
            env: {
              ...process.env,
              OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "25",
              OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "100",
              OPENCLAW_VITEST_RUNTIME: "bun",
              PATH: `${root}:${process.env.PATH ?? ""}`,
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        const completion = waitForClose(runner);
        runner.stderr?.on("data", (chunk) => stderr.push(chunk));
        let childPid = 0;
        let descendantPid = 0;

        try {
          ({ childPid, descendantPid } = await waitForFixtureReady(runner, signal));

          runner.send("advance-watchdog");
          expect(await withinTest(completion, signal)).toEqual({ code: 1, signal: null });
          expect(Buffer.concat(stderr).toString("utf8")).toContain(
            "no output for 100ms; terminating stalled Vitest process group",
          );
          expect(Buffer.concat(stderr).toString("utf8")).toContain("[test:live] still running");
          await waitForProcessExit(childPid, signal);
          await waitForProcessExit(descendantPid, signal);
          expect(existsSync(readFileSync(join(root, "namespace"), "utf8"))).toBe(false);
        } finally {
          await stopFixture(runner, completion, [childPid, descendantPid]);
          rmSync(root, { force: true, recursive: true });
        }
      }),
  );

  it("rejects loose heartbeat intervals instead of parsing prefixes", () => {
    expect(resolveTestLiveHeartbeatMs({})).toBe(20_000);
    expect(resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "2500" })).toBe(2500);
    expect(() => resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1e3" })).toThrow(
      "invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1e3",
    );
    expect(() =>
      resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1000ms" }),
    ).toThrow("invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1000ms");
    expect(() => resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "0" })).toThrow(
      "invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 0",
    );
  });

  it("prints help without spawning live Vitest", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-live.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/test-live.mts");
    expect(result.stdout).not.toContain("Scope:");
    expect(result.stdout).not.toContain("pnpm");
    expect(result.stdout).not.toContain("[test:live]");
  });
});

function writeFakeBun(filePath: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'fs.writeFileSync(require("node:path").join(__dirname, "invocation.json"), JSON.stringify({',
      "  args: process.argv.slice(2), live: process.env.OPENCLAW_LIVE_TEST,",
      "  quiet: process.env.OPENCLAW_LIVE_TEST_QUIET, compileCache: process.env.NODE_DISABLE_COMPILE_CACHE,",
      "}));",
      'const tmp = require("node:os").tmpdir();',
      'fs.writeFileSync(require("node:path").join(__dirname, "namespace"), tmp);',
      'fs.writeFileSync(require("node:path").join(tmp, "owned-marker"), "owned");',
      'for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {',
      "  fs.writeFileSync(process.env.OPENCLAW_FAKE_BUN_SIGNALED_PATH, signal);",
      "  process.exit(0);",
      "});",
      "const child = spawn(process.execPath, [",
      '  "-e",',
      "  [",
      "    \"process.on('SIGTERM', () => {});\",",
      '    "process.send(process.pid);",',
      '    "setInterval(() => {}, 1000);",',
      '  ].join("\\n"),',
      "], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      // Readiness certifies both signal handlers, not merely spawned processes.
      'child.once("message", (pid) => process.stdout.write(`${process.pid} ${pid}\\n`));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodExecutable(filePath);
}

function chmodExecutable(filePath: string): void {
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
      const [child, descendant] = line.split(" ");
      const childPid = Number(child);
      const descendantPid = Number(descendant);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      return { childPid, descendantPid };
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

// The wrapper joins live group members, but Linux may still retain a stopped
// orphan PID until its reaper runs. No child handle exposes that final receipt.
async function waitForProcessExit(pid: number, signal: AbortSignal) {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`timed out waiting for process ${pid} to exit`, { cause: error });
    }
    throw error;
  }
}

function waitForClose(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
