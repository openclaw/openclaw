// Plugin Lifecycle Measure tests cover plugin lifecycle measure script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fixtureLifetime = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirs) => {
  afterEach(async () => {
    // Vitest's timeout settles before the body finally; join that body before removing its inputs.
    await fixtureLifetime.cleanup();
    cleanupDirs();
  });
});
const scriptPath = "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs";

function writeFakeGetconf(dir: string, body: string): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const getconfPath = path.join(binDir, "getconf");
  writeFileSync(getconfPath, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(getconfPath, 0o755);
  return binDir;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The sampler sends SIGKILL before exiting, but does not join foreign PID extinction.
async function waitForPidExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (pidExists(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`process still alive: ${pid}`, { cause: error });
  }
}

function nonEmptyPathExists(filePath: string): boolean {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function observeMeasuredChild(child: ChildProcess) {
  const ready = createDeferred<number>();
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const receipt = stdout.match(/^fixture-ready:(\d+)\r?\n/mu);
    if (receipt) {
      ready.resolve(Number(receipt[1]));
    }
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  void closed.catch(() => {});
  return {
    // The inherited stdout pipe drains before close, so this receipt is ordered with settlement.
    ready: awaitGateBeforeSettlement(
      ready.promise,
      closed,
      "measured wrapper exited before fixture readiness",
    ),
    closed,
  };
}

function expectDrainedBeforeGraceDeadline(stderr: string) {
  const termination = stderr.match(
    /reason=(\S+) signal=SIGTERM exit_ms=([\d.]+) grace_deadline_ms=([\d.]+)/u,
  );
  expect(termination, stderr).not.toBeNull();
  expect(termination?.[1]).toBe("descendants-drained");
  expect(Number(termination?.[2])).toBeLessThan(Number(termination?.[3]));
}

describe("plugin lifecycle resource sampler", () => {
  it.runIf(process.platform === "linux")(
    "derives proc units from getconf when overrides are absent",
    () => {
      const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
      const summary = path.join(dir, "summary.tsv");
      const logPath = path.join(dir, "getconf.log");
      const binDir = writeFakeGetconf(
        dir,
        'printf "%s\\n" "$1" >>"$GETCONF_LOG"\ncase "$1" in PAGESIZE) echo 16384 ;; CLK_TCK) echo 250 ;; esac',
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GETCONF_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      delete env.OPENCLAW_PROC_PAGE_SIZE;
      delete env.OPENCLAW_PROC_CLK_TCK;

      const result = spawnSync(
        process.execPath,
        [scriptPath, summary, "getconf-units", "--", process.execPath, "-e", ""],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env,
          timeout: 5000,
        },
      );

      expect(readFileSync(logPath, "utf8")).toBe("PAGESIZE\nCLK_TCK\n");
      expect(result.stderr).not.toContain("failed to derive OPENCLAW_PROC");
    },
  );

  it("rejects loose numeric env values instead of parsing prefixes", () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "150ms",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS must be a positive integer; got: 150ms",
    );
  });

  it("rejects zero lifecycle timeouts instead of disabling the guard", () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "0",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS must be a positive integer; got: 0",
    );
  });

  it("rejects loose resource ceiling env values instead of parsing prefixes", () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO: "1x",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO must be a positive number; got: 1x",
    );
  });

  it("configures a phase timeout with process-group cleanup", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO");
    expect(script).toContain("detached: true");
    expect(script).toContain("process.kill(-child.pid, signal)");
    expect(script).toContain("plugin lifecycle resource ceiling exceeded");
    expect(script).toContain('const summarySignal = timedOut ? "timeout"');
    expect(script).toContain("process.exit(124)");
  });

  it.runIf(process.platform === "linux").each([
    { actions: false, exitCode: 0 },
    { actions: true, exitCode: 0 },
    { actions: true, exitCode: 9 },
  ])(
    "reports wall ceilings without concealing phase errors (Actions $actions, exit $exitCode)",
    ({ actions, exitCode }) => {
      const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
      const summary = path.join(dir, "summary.tsv");
      const jobSummary = path.join(dir, "job-summary.md");
      const result = spawnSync(
        "node",
        [scriptPath, summary, "slow-success", "--", "node", "-e", `process.exit(${exitCode})`],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ACTIONS: actions ? "true" : "",
            GITHUB_STEP_SUMMARY: jobSummary,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
            OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS: "1",
          },
          timeout: 5000,
        },
      );

      expect(result.status).toBe(actions ? exitCode : 1);
      if (actions) {
        expect(result.stderr).toContain(`::warning file=${scriptPath},line=1,col=0`);
        expect(result.stderr).not.toContain("plugin lifecycle resource ceiling exceeded:");
        expect(readFileSync(jobSummary, "utf8")).toContain("Plugin lifecycle resource budget");
      } else {
        expect(result.stderr).toContain("plugin lifecycle resource ceiling exceeded");
      }
      expect(result.stderr).toContain("wall_ms=");
      expect(readFileSync(summary, "utf8")).toMatch(/^slow-success\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu);
    },
  );

  it.runIf(process.platform === "linux")(
    "times out wedged phases and records the timeout signal",
    () => {
      const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
      const summary = path.join(dir, "summary.tsv");
      const result = spawnSync(
        "node",
        [scriptPath, summary, "wedged", "--", "node", "-e", "setInterval(() => {}, 1000)"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ACTIONS: "true",
            GITHUB_STEP_SUMMARY: "",
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "150",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "50",
          },
          timeout: 5000,
        },
      );

      expect(result.status).toBe(124);
      expect(result.stdout).toContain("signal=timeout");
      expect(readFileSync(summary, "utf8")).toMatch(
        /^wedged\t\d+\t[\d.]+\t\d+\t[\d.]+\ttimeout$/mu,
      );
    },
  );

  it.runIf(process.platform === "linux")("clamps oversized timer env values", () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
    const summary = path.join(dir, "summary.tsv");
    const oversizedTimerMs = "2147000001";
    const result = spawnSync(
      "node",
      [
        scriptPath,
        summary,
        "oversized-timers",
        "--",
        "node",
        "-e",
        "setTimeout(() => process.exit(0), 25)",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS: oversizedTimerMs,
          OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: oversizedTimerMs,
          OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: oversizedTimerMs,
        },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
    expect(readFileSync(summary, "utf8")).toMatch(
      /^oversized-timers\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu,
    );
  });

  it.runIf(process.platform === "linux")(
    "kills stubborn descendants after timeout grace despite disappearing processes",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
        const summary = path.join(dir, "summary.tsv");
        const pidFile = path.join(dir, "descendant.pid");
        const procRaceMarker = path.join(dir, "proc-race");
        const preload = path.join(dir, "vanishing-proc.mjs");
        writeFileSync(
          preload,
          `import fs from "node:fs";
const readdirSync = fs.readdirSync.bind(fs);
const vanishedPid = String(Number(fs.readFileSync("/proc/sys/kernel/pid_max", "utf8")) + 1);
let scans = 0;
let injected = false;
fs.readdirSync = (target, options) => {
  const entries = readdirSync(target, options);
  if (target !== "/proc" || ++scans === 1 || injected) return entries;
  if (!fs.existsSync(process.env.PID_FILE) || fs.statSync(process.env.PID_FILE).size === 0) return entries;
  injected = true;
  fs.writeFileSync(process.env.PROC_RACE_MARKER, vanishedPid);
  // Node resolves unknown Dirent types with lstat, which can race process exit.
  if (options?.withFileTypes) fs.lstatSync("/proc/" + vanishedPid);
  return [...entries, vanishedPid];
};
`,
        );
        let descendantPid: number | undefined;

        try {
          const result = spawnSync(
            "node",
            [
              "--import",
              preload,
              scriptPath,
              summary,
              "stubborn-descendant",
              "--",
              "bash",
              "-lc",
              [
                'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; while :; do sleep 1; done\' &',
                'while [ ! -s "$PID_FILE" ]; do sleep 0.01; done',
                "exit 0",
              ].join("\n"),
            ],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              env: {
                ...process.env,
                OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "3000",
                OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "200",
                PID_FILE: pidFile,
                PROC_RACE_MARKER: procRaceMarker,
              },
              timeout: 7000,
            },
          );

          const resultDetails = JSON.stringify({
            status: result.status,
            signal: result.signal,
            error: result.error?.message,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          expect(nonEmptyPathExists(pidFile), resultDetails).toBe(true);
          descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
          expect(result.status, resultDetails).toBe(124);
          expect(nonEmptyPathExists(procRaceMarker)).toBe(true);
          expect(result.stdout).toContain("signal=timeout");
          expect(readFileSync(summary, "utf8")).toMatch(
            /^stubborn-descendant\t\d+\t[\d.]+\t\d+\t[\d.]+\ttimeout$/mu,
          );
          await waitForPidExit(descendantPid, signal);
          expect(pidExists(descendantPid)).toBe(false);
        } finally {
          if (descendantPid !== undefined && descendantPid > 0 && pidExists(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
        }
      }),
  );

  it.runIf(process.platform === "linux")(
    "forwards external termination to the measured process group",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
        const summary = path.join(dir, "summary.tsv");
        const pidFile = path.join(dir, "descendant.pid");
        let descendantPid: number | undefined;

        let result: ChildProcess | undefined;
        let observed: ReturnType<typeof observeMeasuredChild> | undefined;
        try {
          result = spawn(
            process.execPath,
            [
              scriptPath,
              summary,
              "external-stop",
              "--",
              "bash",
              "-lc",
              'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; printf "fixture-ready:%s\\n" "$$"; while :; do sleep 1; done\' & wait',
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
                OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "200",
                PID_FILE: pidFile,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );

          observed = observeMeasuredChild(result);
          descendantPid = await withinTest(observed.ready, signal);
          expect(Number.parseInt(readFileSync(pidFile, "utf8"), 10)).toBe(descendantPid);
          result.kill("SIGTERM");
          const close = await withinTest(observed.closed, signal);
          expect(close.signal).toBe("SIGTERM");
          expect(close.stderr).toContain("reason=grace-elapsed signal=SIGTERM");
          await waitForPidExit(descendantPid, signal);
          expect(pidExists(descendantPid)).toBe(false);
        } finally {
          if (result?.exitCode === null && result.signalCode === null) {
            result.kill("SIGTERM");
          }
          await observed?.closed.catch(() => {});
          if (descendantPid !== undefined && descendantPid > 0 && pidExists(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
        }
      }),
  );

  it.runIf(process.platform === "linux").for(["open", "closed"])(
    "exits promptly when externally terminated phases stop during grace (stderr %s)",
    (stderr, { signal }) =>
      fixtureLifetime.run(async () => {
        const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
        const summary = path.join(dir, "summary.tsv");
        const readyFile = path.join(dir, "ready.pid");
        const result = spawn(
          "node",
          [
            scriptPath,
            summary,
            "external-fast-stop",
            "--",
            "node",
            "--input-type=module",
            "--eval",
            [
              "import { writeFileSync } from 'node:fs';",
              "process.on('SIGTERM', () => process.exit(0));",
              "writeFileSync(process.env.READY_FILE, String(process.pid));",
              "process.stdout.write('fixture-ready:' + process.pid + '\\n');",
              "setInterval(() => {}, 1000);",
            ].join("\n"),
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
              OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "1500",
              READY_FILE: readyFile,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        const observed = observeMeasuredChild(result);
        try {
          const readyPid = await withinTest(observed.ready, signal);
          expect(Number.parseInt(readFileSync(readyFile, "utf8"), 10)).toBe(readyPid);
          if (stderr === "closed") {
            result.stderr.destroy();
          }
          result.kill("SIGTERM");
          const close = await withinTest(observed.closed, signal);

          if (stderr === "open") {
            expectDrainedBeforeGraceDeadline(close.stderr);
          }
          expect(close.signal).toBe("SIGTERM");
        } finally {
          if (result.exitCode === null && result.signalCode === null) {
            result.kill("SIGTERM");
          }
          await observed.closed.catch(() => {});
        }
      }),
  );

  it.runIf(process.platform === "linux")(
    "exits promptly when shell descendants drain during termination grace",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
        const summary = path.join(dir, "summary.tsv");
        const readyFile = path.join(dir, "ready.pid");
        const result = spawn(
          "node",
          [
            scriptPath,
            summary,
            "external-descendant-drain",
            "--",
            "bash",
            "-lc",
            'trap "exit 0" TERM; bash -c \'trap "sleep 0.15; exit 0" TERM; printf "%s\\n" "$$" >"$READY_FILE"; printf "fixture-ready:%s\\n" "$$"; while :; do sleep 1; done\' & wait',
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
              OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "1500",
              READY_FILE: readyFile,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        const observed = observeMeasuredChild(result);
        try {
          const readyPid = await withinTest(observed.ready, signal);
          expect(Number.parseInt(readFileSync(readyFile, "utf8"), 10)).toBe(readyPid);
          result.kill("SIGTERM");
          const close = await withinTest(observed.closed, signal);

          expectDrainedBeforeGraceDeadline(close.stderr);
          expect(close.signal).toBe("SIGTERM");
        } finally {
          if (result.exitCode === null && result.signalCode === null) {
            result.kill("SIGTERM");
          }
          await observed.closed.catch(() => {});
        }
      }),
  );
});
