import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withRuntimePreload } from "../../../test/helpers/runtime-preload.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout, type CommandOptions } from "../../process/exec.js";
import { workspaceQuiescenceArgv } from "./workspace-quiescence-scripts.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";

const tempDirs = createTempDirTracker();
const idleWorkers: ReturnType<typeof spawn>[] = [];
const watchdogPids = new Set<number>();
afterEach(async () => {
  for (const pid of watchdogPids) {
    retireWatchdog(pid);
  }
  watchdogPids.clear();
  try {
    await Promise.all(idleWorkers.splice(0).map(stopIdleWorker));
  } finally {
    tempDirs.cleanup();
  }
});

function quiescenceCommand(...args: Parameters<typeof workspaceQuiescenceArgv>) {
  return [process.execPath, ...workspaceQuiescenceArgv(...args).slice(1)];
}
const PADDED_PROCESS_START = "Thu Oct  1 00:11:43 2026";

async function fixture(
  probeClock?: "exhaust" | "budget" | "identity" | "recovery" | "prefix" | "retry",
) {
  const root = tempDirs.make("openclaw-quiescence-test-");
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  const leaseDirectory = path.join(home, ".openclaw-worker", "quiescence");
  await Promise.all([home, workspace, bin].map((directory) => fs.mkdir(directory)));
  workspace = await fs.realpath(workspace);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then extra_pid=$(cat "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid" || true; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  const clockPath = path.join(root, "probe-clock.cjs");
  if (probeClock) {
    // Model slow probes on the budget clock; real ps still supplies PIDs and states.
    // Exhaustion cases retain their real killable timeout, and lease expiry uses wall time.
    await fs.writeFile(
      clockPath,
      `
const childProcess = require("node:child_process");
const execFileSync = childProcess.execFileSync;
const now = performance.now.bind(performance);
const mode = ${JSON.stringify(probeClock)};
let elapsed = 0;
let slowProbePending = true;
Object.defineProperty(performance, "now", { value: () => now() + elapsed });
let recoverySocket;
let releaseRecovery;
let recoveryReleased = false;
if (mode === "recovery" || mode === "prefix" || mode === "retry") {
  const schedule = setTimeout;
  global.setTimeout = (callback, delay, ...args) => schedule(() => {
    if (recoverySocket && !recoveryReleased) {
      // Let the parent restore ps before spending another recovery pass.
      releaseRecovery = () => callback(...args);
    } else {
      callback(...args);
    }
  }, Math.min(delay, 10));
}
childProcess.execFileSync = (command, args, options) => {
  if (mode === "prefix" && command === "ps" && args[1] === "lstart=" && require("node:fs").existsSync(${JSON.stringify(path.join(root, "prefix-probes"))})) {
    const fs = require("node:fs");
    const callsPath = ${JSON.stringify(path.join(home, "probe-calls"))};
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\\n").length : 0;
    fs.appendFileSync(callsPath, args.at(-1) + "\\n");
    if (calls % 2 === 1) {
      elapsed += options.timeout;
      throw Object.assign(new Error("simulated unavailable ps"), { code: "ETIMEDOUT", status: null, signal: options.killSignal });
    }
    elapsed += 1000;
  }
  if (mode === "recovery" && command === "ps" && args[1] === "lstart=" && require("node:fs").existsSync(${JSON.stringify(path.join(root, "stall-identity"))})) {
    elapsed += options.timeout;
    require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "recovery-probes"))}, elapsed + "\\n");
    throw Object.assign(new Error("simulated unavailable ps"), { code: "ETIMEDOUT", status: null, signal: options.killSignal });
  }
  const selected = command === "ps" && mode === "identity" && args[1] === "lstart=";
  if (selected && slowProbePending) {
    elapsed += Math.min(3000, options.timeout);
    if (options.timeout < 3000) {
      throw Object.assign(new Error("simulated slow ps"), { code: "ETIMEDOUT", status: null, signal: options.killSignal });
    }
    slowProbePending = false;
  }
  try {
    const output = execFileSync(command, args, options);
    // Exercise ps day padding regardless of the host's date or timezone.
    return mode === "recovery" && command === "ps"
      ? output.replace(/\\w{3} \\w{3} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}/gu, ${JSON.stringify(PADDED_PROCESS_START)})
      : output;
  }
  catch (error) {
    if (mode === "budget" && error.code === "ETIMEDOUT") {
      elapsed += 30000;
      require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "budget-probes"))}, "timeout\\n");
    }
    if ((mode === "exhaust" || mode === "retry") && error.code === "ETIMEDOUT") elapsed += 60000;
    if (mode === "retry" && error.code === "ETIMEDOUT" && !recoverySocket) {
      const fs = require("node:fs");
      const pidPath = ${JSON.stringify(path.join(home, "watchdog-pid"))};
      if (fs.existsSync(pidPath) && process.pid === Number(fs.readFileSync(pidPath, "utf8"))) {
        recoverySocket = require("node:net").createConnection({
          host: "127.0.0.1",
          port: Number(fs.readFileSync(${JSON.stringify(path.join(home, "watchdog-probe-port"))}, "utf8")),
        }, () => recoverySocket.write("timed-out"));
        recoverySocket.once("data", () => {
          recoveryReleased = true;
          recoverySocket.end();
          releaseRecovery?.();
        });
      }
    }
    throw error;
  }
};
`,
    );
  }
  return {
    bin,
    home,
    workspace,
    extraProcessPath,
    leaseDirectory,
    env: {
      ...(probeClock ? withRuntimePreload(process.env, clockPath) : process.env),
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Lease = {
  processes: Array<{ pid: number; start: string }>;
  watchdog: { pid: number };
  expiresAtMs: number;
  sharedHost: boolean;
};

function runQuiescence(
  input: Fixture,
  request: Parameters<typeof workspaceQuiescenceArgv>[1] = {
    action: "acquire",
    nonce: "",
    timeoutMs: 10_000,
  },
  isolation: Parameters<typeof workspaceQuiescenceArgv>[2] = "dedicated",
  options: CommandOptions = {},
) {
  return runCommandWithTimeout(quiescenceCommand(input.workspace, request, isolation), {
    timeoutMs: 10_000,
    baseEnv: input.env,
    ...options,
  });
}

async function readLease(input: Fixture, nonce: string): Promise<Lease> {
  const lease: Lease = JSON.parse(await fs.readFile(leasePath(input, nonce), "utf8"));
  watchdogPids.add(lease.watchdog.pid);
  return lease;
}

async function writePs(input: Fixture, source: string) {
  await fs.writeFile(path.join(input.bin, "ps"), source);
  await fs.chmod(path.join(input.bin, "ps"), 0o755);
}

function retireWatchdog(pid?: number) {
  if (pid === undefined) {
    return;
  }
  watchdogPids.delete(pid);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* Already retired. */
  }
}

async function expireLease(file: string, lease: { expiresAtMs: number }) {
  // Publish atomically so the watchdog never observes partial JSON.
  const expired = file + ".expired";
  await fs.writeFile(expired, JSON.stringify({ ...lease, expiresAtMs: Date.now() - 1 }));
  await fs.rename(expired, file);
}

async function quiesce(input: Fixture, sharedHost = false, watchdogTimeoutMs = "10000") {
  const result = await runQuiescence(
    input,
    { action: "acquire", nonce: "", timeoutMs: Number(watchdogTimeoutMs) },
    sharedHost ? "shared-host" : "dedicated",
  );
  expect(result.code, JSON.stringify(result)).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

function leasePath(input: Fixture, nonce: string) {
  const key = createHash("sha256").update(input.workspace).digest("hex");
  return path.join(input.leaseDirectory, `${key}.${nonce}.json`);
}

// Absolute /bin/ps so the fixture's stubbed PATH entry cannot answer for the real host.
async function processState(pid: number) {
  const result = await runCommandWithTimeout(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
    timeoutMs: 5_000,
  });
  return result.stdout.trim();
}

async function waitForProcessState(pid: number, pattern: RegExp) {
  let state = await processState(pid);
  for (let attempt = 0; attempt < 250 && !pattern.test(state); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    state = await processState(pid);
  }
  return state;
}

// A ps that ignores SIGTERM: execFileSync's timeout signals and then waits for the child, so
// only a killable probe stays bounded against this shape.
const STALLED_PS =
  '#!/bin/sh\ntrap \'\' TERM\ncase "$*" in\n  *"lstart= -p"*) while true; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n';

function spawnIdleWorker() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  expect(child.pid).toBeDefined();
  idleWorkers.push(child);
  return child;
}

async function stopIdleWorker(child: ReturnType<typeof spawnIdleWorker>) {
  child.kill("SIGCONT");
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await once(child, "exit");
  }
}

async function resume(input: Fixture, nonce: string) {
  const result = await release(input, nonce);
  expect(result.code, JSON.stringify(result)).toBe(0);
}

function release(input: Fixture, nonce: string, options: CommandOptions = {}) {
  return runQuiescence(input, { action: "release", nonce }, "dedicated", options);
}

function expectProbeFailure(result: Awaited<ReturnType<typeof runQuiescence>>) {
  expect(result.termination).toBe("exit");
  expect(result.code).not.toBe(0);
}

async function renew(input: Fixture, nonce: string, sharedHost = false) {
  const result = await runQuiescence(
    input,
    { action: "renew", nonce, timeoutMs: 20_000, validationMode: "final" },
    sharedHost ? "shared-host" : "dedicated",
  );
  expect(result).toMatchObject({ code: 0, stdout: `renewed ${nonce}\n` });
}

function workspaceCaller(
  input: Fixture,
  ownerSignal = new AbortController().signal,
  timeoutMs = 10_000,
) {
  return createWorkerWorkspaceQuiescence({
    ownerSignal,
    sharedHost: false,
    runWorkspaceCommand: (command) =>
      runCommandWithTimeout([process.execPath, ...command.argv.slice(1)], {
        timeoutMs,
        baseEnv: input.env,
      }),
  });
}

function standaloneRenew(input: Fixture, nonce: string, heartbeat = false) {
  return runCommandWithTimeout(
    quiescenceCommand(
      input.workspace,
      {
        action: "renew",
        nonce,
        timeoutMs: 20_000,
        validationMode: heartbeat ? "heartbeat" : "final",
      },
      "dedicated",
    ).slice(0, heartbeat ? 7 : 5),
    { timeoutMs: 10_000, baseEnv: input.env },
  );
}

async function withSharedLease(
  run: (
    input: Fixture,
    nonce: string,
    lease: Lease,
    file: string,
    healthyPs: string,
  ) => Promise<void>,
  timeout = "30000",
) {
  const input = await fixture("exhaust");
  const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
  const nonce = await quiesce(input, true, timeout);
  const lease = await readLease(input, nonce);
  try {
    await run(input, nonce, lease, leasePath(input, nonce), healthyPs);
  } finally {
    await writePs(input, healthyPs);
    retireWatchdog(lease.watchdog.pid);
  }
}

describe("remote workspace quiescence scripts", () => {
  it("recovers a slow identity probe within the shared budget", async () => {
    const input = await fixture("identity");
    const result = await runQuiescence(input);
    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.stderr).toContain("slow ps check; retrying");
    const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout)?.[1];
    expect(nonce).toBeDefined();
    await resume(input, nonce!);
  });

  it("surfaces an exhausted probe budget through the workspace caller", async () => {
    const input = await fixture("budget");
    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    const acquire = workspaceCaller(input, undefined, 45_000);
    await expect(acquire(input.workspace)).rejects.toThrow(
      "workspace quiescence process check budget exhausted after 30000 ms",
    );
    // A renewed budget must not authorize another probe after 30s of simulated delay.
    await expect(fs.readFile(path.join(input.home, "..", "budget-probes"), "utf8")).resolves.toBe(
      "timeout\n",
    );
    await expect(fs.readdir(input.leaseDirectory)).resolves.toEqual([]);
  }, 60_000);

  it("does not renew a lease that expires during a process probe", async () => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true);
    const leaseFile = leasePath(input, nonce);
    await fs.writeFile(
      path.join(input.bin, "ps"),
      `#!${process.execPath}
const fs = require("node:fs");
const leaseFile = ${JSON.stringify(leaseFile)};
const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
lease.expiresAtMs = Date.now() - 1;
fs.writeFileSync(leaseFile, JSON.stringify(lease));
require("node:child_process").execFileSync("/bin/ps", process.argv.slice(2), { stdio: "inherit" });
`,
    );
    try {
      const result = await runQuiescence(
        input,
        { action: "renew", nonce, timeoutMs: 20_000, validationMode: "heartbeat" },
        "shared-host",
      );
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain("lease expired during process checking");
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as { expiresAtMs: number };
      expect(lease.expiresAtMs).toBeLessThan(Date.now());
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await resume(input, nonce);
    }
  });

  it("stops a writable process that appeared after the workspace was quiesced", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    // Omit the host argument to retain coverage of the standalone dedicated default.
    const heartbeat = await standaloneRenew(input, nonce, true);
    expect(heartbeat.code).toBe(0);

    try {
      // Omit all optional renewal arguments to exercise the standalone defaults.
      const result = await standaloneRenew(input, nonce);

      expect(result.code).toBe(0);
      const lease = await readLease(input, nonce);
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
    } finally {
      await resume(input, nonce);
    }
    expect((await standaloneRenew(input, nonce)).code).not.toBe(0);
  });

  it("keeps unrelated same-uid processes running on a declared shared host", async () => {
    const input = await fixture();
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    const nonce = await quiesce(input, true);
    try {
      await renew(input, nonce, true);
      const lease = await readLease(input, nonce);
      expect(lease).toMatchObject({ processes: [], sharedHost: true });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      await resume(input, nonce);
    }
  });

  it("cleans up the initial watchdog when identity probing times out", async () => {
    const input = await fixture("exhaust");
    const watchdogPidPath = path.join(input.home, "initial-watchdog.pid");
    await writePs(
      input,
      `#!/bin/sh
case "$*" in
  *"lstart= -p"*)
    for pid do :; done
    printf "%s\n" "$pid" > "$OPENCLAW_TEST_WATCHDOG_PID"
    trap '' TERM
    while true; do sleep 1; done
    ;;
  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\n" "$$" "$PPID" "$(id -u)" ;;
esac
`,
    );
    const result = await runQuiescence(input, undefined, "dedicated", {
      baseEnv: { ...input.env, OPENCLAW_TEST_WATCHDOG_PID: watchdogPidPath },
    });

    expectProbeFailure(result);
    const watchdogPid = Number((await fs.readFile(watchdogPidPath, "utf8")).trim());
    expect(Number.isSafeInteger(watchdogPid)).toBe(true);
    await expect(fs.readdir(input.leaseDirectory)).resolves.toEqual([]);
    await vi.waitFor(() => {
      expect(() => process.kill(watchdogPid, 0)).toThrow();
    });
  });

  it("releases an empty shared-host lease without depending on ps", async () => {
    await withSharedLease(async (input, nonce, lease, leaseFile) => {
      await writePs(input, STALLED_PS);
      const result = await release(input, nonce, { timeoutMs: 15_000 });
      expect(result).toMatchObject({ termination: "exit", code: 0 });
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await vi.waitFor(
        () => {
          expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
        },
        { timeout: 5_000 },
      );
    }, "1000");
  });

  it("removes an empty shared-host orphan lease without depending on ps", async () => {
    await withSharedLease(async (input, _nonce, _lease, leaseFile) => {
      await writePs(input, STALLED_PS);
      const result = await runQuiescence(input, undefined, "shared-host", { timeoutMs: 15_000 });

      // Starting the replacement watchdog still needs ps and fails closed, but the stale
      // empty lease must already be gone so it cannot block another reconciliation attempt.
      expectProbeFailure(result);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    });
  });

  it("retains an unverified empty orphan lease until a dedicated retry can retire it", async () => {
    await withSharedLease(async (input, _firstNonce, firstLease, firstLeaseFile, healthyPs) => {
      let replacementNonce: string | undefined;

      await writePs(input, STALLED_PS);
      try {
        const failed = await runQuiescence(input, undefined, "dedicated", { timeoutMs: 15_000 });

        expectProbeFailure(failed);
        await fs.access(firstLeaseFile);

        await writePs(input, healthyPs);
        await fs.writeFile(input.extraProcessPath, `${firstLease.watchdog.pid}\n`);
        replacementNonce = await quiesce(input, false, "10000");
        const replacementLease = await readLease(input, replacementNonce);

        expect(replacementLease.processes).not.toContainEqual({ pid: firstLease.watchdog.pid });
        expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
        await expect(fs.access(firstLeaseFile)).rejects.toThrow();
      } finally {
        await writePs(input, healthyPs);
        if (replacementNonce !== undefined) {
          await resume(input, replacementNonce);
        }
      }
    });
  });

  it("keeps the watchdog resumer alive when the identity sweep aborts partway", async () => {
    const input = await fixture("exhaust");
    const child = spawnIdleWorker();
    const pid = child.pid!;
    await fs.writeFile(input.extraProcessPath, String(pid));
    const nonce = await quiesce(input);
    const lease = await readLease(input, nonce);
    expect(lease.processes.some((entry) => entry.pid === pid)).toBe(true);
    const watchdogPid = lease.watchdog.pid;

    // Identity stays answerable for the watchdog but stalls for the frozen worker, so the
    // sweep aborts exactly where the old order had already retired the last resumer.
    await writePs(
      input,
      `#!/bin/sh\ntrap '' TERM\ncase "$*" in\n  *"lstart= -p ${watchdogPid}") exec /bin/ps "$@" ;;\n  *"lstart= -p"*) while true; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n`,
    );

    const result = await release(input, nonce, { timeoutMs: 15_000 });
    expectProbeFailure(result);
    // The watchdog is the only owner left that can still thaw this lease.
    expect(result.stderr).toContain(`workspace quiescence recovery pending PIDs: ${pid}`);
    expect(() => process.kill(watchdogPid, 0)).not.toThrow();
  });

  it("resumes every worker without revisiting a recovered prefix after probe exhaustion", async () => {
    const input = await fixture("prefix");
    const workers = Array.from({ length: 16 }, spawnIdleWorker);
    const pids = workers.map((worker) => worker.pid!);
    const callsPath = path.join(input.home, "probe-calls");
    await fs.writeFile(input.extraProcessPath, pids.join(","));
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input, nonce);
    const lease = await readLease(input, nonce);
    expect(
      lease.processes.map((entry) => entry.pid).toSorted((left, right) => left - right),
    ).toEqual(pids.toSorted((left, right) => left - right));
    for (const pid of pids) {
      expect(await processState(pid)).toMatch(/^T/u);
    }
    // Drive the watchdog's real identity probes across a virtual shared budget.
    await fs.writeFile(path.join(input.home, "..", "prefix-probes"), "");
    await expireLease(leaseFile, lease);
    const firstPid = lease.processes[0]!.pid;
    let calls: number[] = [];
    let leaseExists = true;
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline && leaseExists) {
      const trace = await fs.readFile(callsPath, "utf8").catch(() => "");
      calls = trace.trim().split(/\s+/u).filter(Boolean).map(Number);
      // Fail as soon as a later pass spends its budget on an already recovered worker.
      if (calls.filter((pid) => pid === firstPid).length > 1) {
        break;
      }
      leaseExists = await fs.stat(leaseFile).then(
        () => true,
        () => false,
      );
      if (leaseExists) {
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    }
    expect(calls.filter((pid) => pid === firstPid)).toHaveLength(1);
    expect(leaseExists, `probe calls: ${calls.join(",")}`).toBe(false);
    expect(calls.length).toBeGreaterThan(pids.length);
    expect(calls.length).toBeLessThanOrEqual(35);
    for (const pid of pids) {
      expect(await processState(pid)).not.toMatch(/^T/u);
    }
  }, 100_000);

  it("ends recovery within the total budget when every identity probe times out", async () => {
    const input = await fixture("recovery");
    const workers = Array.from({ length: 8 }, spawnIdleWorker);
    await fs.writeFile(input.extraProcessPath, workers.map((worker) => worker.pid).join(","));
    const owner = new AbortController();
    const stallPath = path.join(input.home, "..", "stall-identity");
    const probesPath = path.join(input.home, "..", "recovery-probes");
    try {
      const acquire = workspaceCaller(input, owner.signal);
      const quiescence = await acquire(input.workspace);
      const leaseFile = path.join(
        input.leaseDirectory,
        (await fs.readdir(input.leaseDirectory))[0]!,
      );
      const lease: Lease = JSON.parse(await fs.readFile(leaseFile, "utf8"));
      const watchdogPid = lease.watchdog.pid;
      watchdogPids.add(watchdogPid);
      expect(lease.processes).toHaveLength(workers.length);
      await fs.writeFile(stallPath, "");
      // Publish expiry atomically, like the owner: the watchdog must never see partial JSON.
      await expireLease(leaseFile, lease);
      let probeElapsed = 0;
      await vi.waitFor(async () => {
        const trace = await fs.readFile(probesPath, "utf8").catch(() => "0");
        probeElapsed = Number(trace.trim().split("\n").at(-1));
        // Stop the pre-fix proof at its first excess pass, without waiting forever.
        expect(probeElapsed > 120_000 || /^(?:Z|$)/u.test(await processState(watchdogPid!))).toBe(
          true,
        );
      });
      expect(probeElapsed).toBeLessThanOrEqual(120_000);
      expect(await processState(watchdogPid)).toMatch(/^(?:Z|$)/u);
      const exhausted = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        recoveryError: string;
        processes: typeof lease.processes;
      };
      expect(exhausted.processes).toEqual(lease.processes);
      expect(exhausted.recoveryError).toContain("recovery exhausted after 4 check passes");
      expect(exhausted.recoveryError).toContain("retry workspace recovery");
      await expect(quiescence.resume()).rejects.toThrow(exhausted.recoveryError);
      for (const entry of lease.processes) {
        expect(entry.start).toBe(PADDED_PROCESS_START);
        expect(exhausted.recoveryError).toContain(
          JSON.stringify({ ...entry, start: "Thu Oct 1 00:11:43 2026" }),
        );
        expect(await processState(entry.pid)).toMatch(/^T/u);
      }
      await fs.unlink(stallPath);
      await quiescence.resume();
      await expect(fs.stat(leaseFile)).rejects.toThrow();
      for (const worker of workers) {
        expect(await processState(worker.pid!)).not.toMatch(/^T/u);
      }
    } finally {
      owner.abort();
    }
  });

  it("recovers a frozen worker once a stalled ps answers again after lease expiry", async () => {
    const input = await fixture("retry");
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    const watchdogProbeTimedOut = createDeferred();
    let connection: Socket | undefined;
    const probeServer = createServer((socket) => {
      connection = socket;
      socket.once("data", () => watchdogProbeTimedOut.resolve());
      socket.on("error", watchdogProbeTimedOut.reject);
    });
    let watchdogPid: number | undefined;
    try {
      const listening = once(probeServer, "listening");
      probeServer.listen(0, "127.0.0.1");
      await listening;
      const address = probeServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing probe acknowledgement listener");
      }
      await fs.writeFile(path.join(input.home, "watchdog-probe-port"), String(address.port));
      const nonce = await quiesce(input, false, "6000");
      const lease = await readLease(input, nonce);
      watchdogPid = lease.watchdog.pid;
      expect(await waitForProcessState(child.pid!, /^T/u)).toMatch(/^T/u);
      await fs.writeFile(path.join(input.home, "watchdog-pid"), String(lease.watchdog.pid));

      // ps stays stalled across the failed resume and past lease expiry, so only a
      // watchdog that keeps re-probing identity can still thaw this worker.
      await writePs(input, STALLED_PS);

      const failed = await release(input, nonce, { timeoutMs: 15_000 });
      expect(failed.code).not.toBe(0);

      const leaseFile = leasePath(input, nonce);
      await expireLease(leaseFile, lease);
      await watchdogProbeTimedOut.promise;
      expect(await processState(child.pid!)).toMatch(/^T/u);
      // An exhausted post-expiry probe must leave the watchdog able to retry recovery.
      expect(() => process.kill(lease.watchdog.pid, 0)).not.toThrow();

      await writePs(input, healthyPs);
      connection!.write("retry");

      // SIGCONT precedes lease removal. Wait for the watchdog's terminal state,
      // including an unreaped zombie, before asserting its completed cleanup.
      expect(await waitForProcessState(lease.watchdog.pid, /^(?:Z|$)/u)).toMatch(/^(?:Z|$)/u);
      expect(await processState(child.pid!)).toMatch(/^[^T]/u);
      await expect(fs.stat(leaseFile)).rejects.toThrow();
    } finally {
      retireWatchdog(watchdogPid);
      connection?.destroy();
      await new Promise<void>((resolve) => {
        probeServer.close(() => resolve());
      });
    }
  }, 60_000);
});
