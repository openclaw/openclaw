import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
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

function measureFixture() {
  const dir = tempDirs.make("openclaw-plugin-lifecycle-measure-");
  return { dir, summary: path.join(dir, "summary.tsv") };
}

function runMeasure(
  summary: string,
  phase: string,
  env: NodeJS.ProcessEnv,
  command = ["node", "-e", ""],
  { preload = "", timeout = 5000 } = {},
) {
  return spawnSync(
    "node",
    [...(preload ? ["--import", preload] : []), scriptPath, summary, phase, "--", ...command],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...env }, timeout },
  );
}

function checkTermination(
  signal: AbortSignal,
  phase: string,
  command: string[],
  check: (
    close: Awaited<ReturnType<typeof observeMeasuredChild>["closed"]>,
    pid: number,
  ) => void | Promise<void>,
  { graceMs = "1500", closeStderr = false, stubborn = false } = {},
) {
  return fixtureLifetime.run(async () => {
    const { dir, summary } = measureFixture();
    const pidFile = path.join(dir, stubborn ? "descendant.pid" : "ready.pid");
    const result = spawn(
      stubborn ? process.execPath : "node",
      [scriptPath, summary, phase, "--", ...command],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
          OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: graceMs,
          [stubborn ? "PID_FILE" : "READY_FILE"]: pidFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const observed = observeMeasuredChild(result);
    let pid: number | undefined;
    try {
      pid = await withinTest(observed.ready, signal);
      expect(Number.parseInt(readFileSync(pidFile, "utf8"), 10)).toBe(pid);
      if (closeStderr) {
        result.stderr.destroy();
      }
      result.kill("SIGTERM");
      await check(await withinTest(observed.closed, signal), pid);
    } finally {
      if (result.exitCode === null && result.signalCode === null) {
        result.kill("SIGTERM");
      }
      await observed.closed.catch(() => {});
      if (stubborn && pid !== undefined && pid > 0 && pidExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
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
  while (pidExists(pid)) {
    await delay(5, undefined, { signal });
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
  const closed = new Promise<{ signal: NodeJS.Signals | null; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_code, signal) => resolve({ signal, stderr }));
    },
  );
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

it.runIf(process.platform === "linux")(
  "derives proc units from getconf when overrides are absent",
  () => {
    const { dir, summary } = measureFixture();
    const logPath = path.join(dir, "getconf.log");
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const getconf = path.join(binDir, "getconf");
    writeFileSync(
      getconf,
      '#!/bin/sh\nprintf "%s\\n" "$1" >>"$GETCONF_LOG"\ncase "$1" in PAGESIZE) echo 16384 ;; CLK_TCK) echo 250 ;; esac\n',
    );
    chmodSync(getconf, 0o755);
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

it.each([
  ["PHASE_TIMEOUT_MS", "150ms", "integer"],
  ["PHASE_TIMEOUT_MS", "0", "integer"],
  ["MAX_CPU_CORE_RATIO", "1x", "number"],
])("rejects invalid %s=%s", (setting, value, kind) => {
  const name = `OPENCLAW_PLUGIN_LIFECYCLE_${setting}`;
  const result = runMeasure(measureFixture().summary, "invalid-env", { [name]: value });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`${name} must be a positive ${kind}; got: ${value}`);
});

it.runIf(process.platform === "linux")("fails successful phases that exceed wall ceilings", () => {
  const { summary } = measureFixture();
  const result = runMeasure(
    summary,
    "slow-success",
    {
      GITHUB_ACTIONS: "",
      OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
      OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS: "1",
    },
    ["node", "-e", "process.exit(0)"],
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("plugin lifecycle resource ceiling exceeded");
  expect(result.stderr).toContain("wall_ms=");
  expect(readFileSync(summary, "utf8")).toMatch(/^slow-success\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu);
});

it.runIf(process.platform === "linux")("clamps oversized timer env values", () => {
  const { summary } = measureFixture();
  const oversizedTimerMs = "2147000001";
  const result = runMeasure(
    summary,
    "oversized-timers",
    {
      OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS: oversizedTimerMs,
      OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: oversizedTimerMs,
      OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: oversizedTimerMs,
    },
    ["node", "-e", "setTimeout(() => process.exit(0), 25)"],
  );

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  expect(readFileSync(summary, "utf8")).toMatch(/^oversized-timers\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu);
});

it.runIf(process.platform === "linux")(
  "kills stubborn descendants after timeout grace despite disappearing processes",
  ({ signal }) =>
    fixtureLifetime.run(async () => {
      const { dir, summary } = measureFixture();
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
        const result = runMeasure(
          summary,
          "stubborn-descendant",
          {
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "3000",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "200",
            PID_FILE: pidFile,
            PROC_RACE_MARKER: procRaceMarker,
          },
          [
            "bash",
            "-lc",
            [
              'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; while :; do sleep 1; done\' &',
              'while [ ! -s "$PID_FILE" ]; do sleep 0.01; done',
              "exit 0",
            ].join("\n"),
          ],
          { preload, timeout: 7000 },
        );

        const details = `${result.status}/${result.signal}: ${result.error?.message}\n${result.stdout}\n${result.stderr}`;
        expect(nonEmptyPathExists(pidFile), details).toBe(true);
        descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        expect(result.status, details).toBe(124);
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
    checkTermination(
      signal,
      "external-stop",
      [
        "bash",
        "-lc",
        'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; printf "fixture-ready:%s\\n" "$$"; while :; do sleep 1; done\' & wait',
      ],
      async (close, descendantPid) => {
        expect(close.signal).toBe("SIGTERM");
        expect(close.stderr).toContain("reason=grace-elapsed signal=SIGTERM");
        await waitForPidExit(descendantPid, signal);
        expect(pidExists(descendantPid)).toBe(false);
      },
      { graceMs: "200", stubborn: true },
    ),
);

it.runIf(process.platform === "linux").for(["open", "closed"])(
  "exits promptly when externally terminated phases stop during grace (stderr %s)",
  (stderr, { signal }) =>
    checkTermination(
      signal,
      "external-fast-stop",
      [
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
      (close) => {
        if (stderr === "open") {
          expectDrainedBeforeGraceDeadline(close.stderr);
        }
        expect(close.signal).toBe("SIGTERM");
      },
      { closeStderr: stderr === "closed" },
    ),
);

it.runIf(process.platform === "linux")(
  "exits promptly when shell descendants drain during termination grace",
  ({ signal }) =>
    checkTermination(
      signal,
      "external-descendant-drain",
      [
        "bash",
        "-lc",
        'trap "exit 0" TERM; bash -c \'trap "sleep 0.15; exit 0" TERM; printf "%s\\n" "$$" >"$READY_FILE"; printf "fixture-ready:%s\\n" "$$"; while :; do sleep 1; done\' & wait',
      ],
      (close) => {
        expectDrainedBeforeGraceDeadline(close.stderr);
        expect(close.signal).toBe("SIGTERM");
      },
    ),
);
