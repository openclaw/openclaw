import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(
  probeClock?: "exhaust" | "budget" | "census" | "identity" | "recovery" | "prefix" | "retry",
) {
  const root = tempDirs.make("openclaw-quiescence-test-");
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then extra_pid=$(cat "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid" || true; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  const clockPath = path.join(root, "probe-clock.cjs");
  if (probeClock) {
    // Model slow probes on the budget clock; real ps still supplies process identities.
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
  const selected = command === "ps" &&
    (mode === "census" ? args[0] === "-axo" : mode === "identity" && args[1] === "lstart=");
  if (selected && slowProbePending) {
    elapsed += Math.min(3000, options.timeout);
    if (options.timeout < 3000) {
      throw Object.assign(new Error("simulated slow ps"), { code: "ETIMEDOUT", status: null, signal: options.killSignal });
    }
    slowProbePending = false;
  }
  try { return execFileSync(command, args, options); }
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
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...(probeClock
        ? {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(clockPath)}`,
          }
        : {}),
    },
  };
}

async function quiesce(
  input: Awaited<ReturnType<typeof fixture>>,
  sharedHost = false,
  watchdogTimeoutMs = "10000",
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      input.workspace,
      watchdogTimeoutMs,
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code, JSON.stringify(result)).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  if (sharedHost) {
    expect(result.stderr).toContain(
      process.platform === "win32"
        ? "Windows shared host declared; using manifest fences without process freezing"
        : "shared host declared; skipping process freeze sweep",
    );
  }
  return match![1]!;
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
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
  return child;
}

async function stopIdleWorker(child: ReturnType<typeof spawnIdleWorker>) {
  child.kill("SIGCONT");
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await once(child, "exit");
  }
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code, JSON.stringify(result)).toBe(0);
}

async function renew(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  sharedHost = false,
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
      input.workspace,
      nonce,
      "20000",
      "final",
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`renewed ${nonce}\n`);
}

describe("remote workspace quiescence scripts", () => {
  it("excludes its ps scanner and terminates its watchdog on resume", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const lease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
    ) as {
      watchdog: { pid: number; start: string };
    };

    await resume(input, nonce);

    await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    await vi.waitFor(() => {
      expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
    });
  });

  it.each(["census", "identity"] as const)(
    "recovers a slow %s probe within the shared budget",
    async (probe) => {
      const input = await fixture(probe);
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          input.workspace,
          "10000",
          "dedicated",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.stderr).toContain("slow ps probe; retrying");
      const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout)?.[1];
      expect(nonce).toBeDefined();
      await resume(input, nonce!);
    },
  );

  it("surfaces an exhausted probe budget through the workspace caller", async () => {
    const input = await fixture("budget");
    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    const results: Awaited<ReturnType<typeof runCommandWithTimeout>>[] = [];
    const acquire = createWorkerWorkspaceQuiescence({
      ownerSignal: new AbortController().signal,
      sharedHost: false,
      runWorkspaceCommand: async (command) => {
        const result = await runCommandWithTimeout([process.execPath, ...command.argv.slice(1)], {
          timeoutMs: 45_000,
          baseEnv: input.env,
        });
        results.push(result);
        return result;
      },
    });
    await expect(acquire(input.workspace)).rejects.toThrow(
      "workspace quiescence process probe budget exhausted after 30000 ms",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.termination).toBe("exit");
    expect(results[0]?.code).toBe(1);
    expect(results[0]?.stderr).toContain("slow ps probe; retrying");
    expect(results[0]?.stderr.slice(0, 900)).toContain("probe budget exhausted after 30000 ms");
    // A renewed budget must not authorize another probe after 30s of simulated delay.
    await expect(fs.readFile(path.join(input.home, "..", "budget-probes"), "utf8")).resolves.toBe(
      "timeout\n",
    );
    await expect(
      fs.readdir(path.join(input.home, ".openclaw-worker", "quiescence")),
    ).resolves.toEqual([]);
  }, 60_000);

  it("recovers a prior nonce without letting its watchdog own the next lease", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input, false, "1000");
    const firstLease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, firstNonce), "utf8"),
    ) as { watchdog: { pid: number; start: string } };

    const secondNonce = await quiesce(input);

    expect(secondNonce).not.toBe(firstNonce);
    await expect(fs.access(leasePath(input.home, input.workspace, firstNonce))).rejects.toThrow();
    await expect(
      fs.access(leasePath(input.home, input.workspace, secondNonce)),
    ).resolves.toBeUndefined();
    await vi.waitFor(
      () => {
        expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
      },
      { timeout: 5_000 },
    );
    await resume(input, secondNonce);
  });

  it("proves the lease is active and renews its watchdog deadline", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };

    await renew(input, nonce);

    const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
    expect(after.watchdog).toEqual(before.watchdog);
    expect(() => process.kill(after.watchdog.pid, 0)).not.toThrow();
    await resume(input, nonce);
  });

  it("does not renew a lease that expires during a process probe", async () => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
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
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
          "heartbeat",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain("lease expired during process probing");
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
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    const heartbeat = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        input.workspace,
        nonce,
        "20000",
        "heartbeat",
      ],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(heartbeat.code).toBe(0);

    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).toBe(0);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
    } finally {
      await resume(input, nonce);
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("keeps unrelated same-uid processes running on a declared shared host", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    let nonce: string | undefined;
    try {
      nonce = await quiesce(input, true);
      await renew(input, nonce, true);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; sharedHost: boolean };
      expect(lease).toMatchObject({ processes: [], sharedHost: true });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (nonce) {
        await resume(input, nonce);
      }
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("fails closed when the watchdog lease no longer exists", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    await resume(input, nonce);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(result.code).not.toBe(0);
  });

  it("cleans up the initial watchdog when identity probing times out", async () => {
    const input = await fixture("exhaust");
    const watchdogPidPath = path.join(input.home, "initial-watchdog.pid");
    await fs.writeFile(
      path.join(input.bin, "ps"),
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
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000", "dedicated"],
      {
        timeoutMs: 10_000,
        baseEnv: { ...input.env, OPENCLAW_TEST_WATCHDOG_PID: watchdogPidPath },
      },
    );

    expect(result.termination).toBe("exit");
    expect(result.code).not.toBe(0);
    const watchdogPid = Number((await fs.readFile(watchdogPidPath, "utf8")).trim());
    expect(Number.isSafeInteger(watchdogPid)).toBe(true);
    const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
    await expect(fs.readdir(leaseDirectory)).resolves.toEqual([]);
    await vi.waitFor(() => {
      expect(() => process.kill(watchdogPid, 0)).toThrow();
    });
  });

  it("releases an empty shared-host lease without depending on ps", async () => {
    const input = await fixture("exhaust");
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true, "1000");
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as { watchdog: { pid: number } };

    // Shared hosts intentionally freeze nothing. A ps outage must not block a no-op release or
    // turn a successfully reconciled worker result into an error.
    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(result.termination).toBe("exit");
      expect(result.code).toBe(0);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await vi.waitFor(
        () => {
          expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
        },
        { timeout: 5_000 },
      );
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      try {
        process.kill(lease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the missing lease has retired it.
      }
    }
  });

  it.each([
    ["shared-host", true],
    ["dedicated", false],
  ])("removes an empty %s orphan lease without depending on ps", async (_mode, sharedHost) => {
    const input = await fixture("exhaust");
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true, "30000");
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      sharedHost: boolean;
      watchdog: { pid: number };
    };
    lease.sharedHost = sharedHost;
    await fs.writeFile(leaseFile, JSON.stringify(lease));

    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          input.workspace,
          "10000",
          "shared-host",
        ],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      // Starting the replacement watchdog still needs ps and fails closed, but the stale
      // empty lease must already be gone so it cannot block another reconciliation attempt.
      expect(result.termination).toBe("exit");
      expect(result.code).not.toBe(0);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      try {
        process.kill(lease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the missing lease has retired it.
      }
    }
  });

  it("retains an unverified empty orphan lease until a dedicated retry can retire it", async () => {
    const input = await fixture("exhaust");
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const firstNonce = await quiesce(input, true, "30000");
    const firstLeaseFile = leasePath(input.home, input.workspace, firstNonce);
    const firstLease = JSON.parse(await fs.readFile(firstLeaseFile, "utf8")) as {
      watchdog: { pid: number };
    };
    let replacementNonce: string | undefined;

    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);
    try {
      const failed = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          input.workspace,
          "10000",
          "dedicated",
        ],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(failed.termination).toBe("exit");
      expect(failed.code).not.toBe(0);
      await expect(fs.access(firstLeaseFile)).resolves.toBeUndefined();

      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      replacementNonce = await quiesce(input, false, "10000");
      const replacementLease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, replacementNonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };

      expect(replacementLease.processes).not.toContainEqual({ pid: firstLease.watchdog.pid });
      await expect(fs.access(firstLeaseFile)).rejects.toThrow();
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      if (replacementNonce !== undefined) {
        await resume(input, replacementNonce);
      }
      try {
        process.kill(firstLease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the healthy retry retires it.
      }
    }
  });

  it("retires an empty orphan watchdog before a dedicated replacement sweep", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input, true, "30000");
    const firstLeaseFile = leasePath(input.home, input.workspace, firstNonce);
    const firstLease = JSON.parse(await fs.readFile(firstLeaseFile, "utf8")) as {
      watchdog: { pid: number };
    };
    await fs.writeFile(input.extraProcessPath, `${firstLease.watchdog.pid}\n`);

    let replacementNonce: string | undefined;
    try {
      replacementNonce = await quiesce(input, false, "10000");
      const replacementLease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, replacementNonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };

      expect(replacementLease.processes).not.toContainEqual({ pid: firstLease.watchdog.pid });
      expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
    } finally {
      if (replacementNonce !== undefined) {
        await resume(input, replacementNonce);
      }
      try {
        process.kill(firstLease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once orphan recovery retires it.
      }
    }
  });

  it("thaws a real stopped worker and clears the lease", async () => {
    const input = await fixture();
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    try {
      const nonce = await quiesce(input);
      expect(await waitForProcessState(child.pid!, /^T/u)).toMatch(/^T/u);

      await resume(input, nonce);

      expect(await waitForProcessState(child.pid!, /^[^T]/u)).not.toMatch(/^T/u);
      await expect(fs.stat(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("keeps the watchdog resumer alive when the identity sweep aborts partway", async () => {
    const input = await fixture("exhaust");
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);
    let watchdogPid: number | undefined;

    try {
      const nonce = await quiesce(input);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; watchdog: { pid: number } };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
      watchdogPid = lease.watchdog.pid;

      // Identity stays answerable for the watchdog but stalls for the frozen worker, so the
      // sweep aborts exactly where the old order had already retired the last resumer.
      await fs.writeFile(
        path.join(input.bin, "ps"),
        `#!/bin/sh\ntrap '' TERM\ncase "$*" in\n  *"lstart= -p ${watchdogPid}") exec /bin/ps "$@" ;;\n  *"lstart= -p"*) while true; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n`,
      );
      await fs.chmod(path.join(input.bin, "ps"), 0o755);

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(result.termination).toBe("exit");
      expect(result.code).not.toBe(0);
      // The watchdog is the only owner left that can still thaw this lease.
      expect(result.stderr).toContain(`workspace quiescence recovery pending PIDs: ${child.pid}`);
      expect(() => process.kill(watchdogPid!, 0)).not.toThrow();
    } finally {
      if (watchdogPid !== undefined) {
        try {
          process.kill(watchdogPid, "SIGTERM");
        } catch {
          // Already gone; the assertion above owns that outcome.
        }
      }
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("resumes every worker without revisiting a recovered prefix after probe exhaustion", async () => {
    const input = await fixture("prefix");
    const workers = Array.from({ length: 16 }, () => spawnIdleWorker());
    const pids = workers.map((worker) => worker.pid!);
    const callsPath = path.join(input.home, "probe-calls");
    let watchdogPid: number | undefined;
    try {
      await fs.writeFile(input.extraProcessPath, pids.join(","));
      const nonce = await quiesce(input, false, "10000");
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number }>;
        watchdog: { pid: number };
      };
      watchdogPid = lease.watchdog.pid;
      expect(
        lease.processes.map((entry) => entry.pid).toSorted((left, right) => left - right),
      ).toEqual(pids.toSorted((left, right) => left - right));
      for (const pid of pids) {
        expect(await processState(pid)).toMatch(/^T/u);
      }
      // Drive the watchdog's real identity probes across a virtual shared budget.
      await fs.writeFile(path.join(input.home, "..", "prefix-probes"), "");
      const expiredLeaseFile = `${leaseFile}.expired`;
      await fs.writeFile(
        expiredLeaseFile,
        JSON.stringify({ ...lease, expiresAtMs: Date.now() - 1 }),
      );
      await fs.rename(expiredLeaseFile, leaseFile);
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
    } finally {
      if (watchdogPid !== undefined) {
        try {
          process.kill(watchdogPid, "SIGTERM");
        } catch {
          /* Already retired after recovery. */
        }
      }
      await Promise.all(workers.map(stopIdleWorker));
    }
  }, 100_000);

  it("ends recovery within the total budget when every identity probe times out", async () => {
    const input = await fixture("recovery");
    const workers = Array.from({ length: 8 }, () => spawnIdleWorker());
    const owner = new AbortController();
    const stallPath = path.join(input.home, "..", "stall-identity");
    const probesPath = path.join(input.home, "..", "recovery-probes");
    let watchdogPid: number | undefined;
    try {
      await fs.writeFile(input.extraProcessPath, workers.map((worker) => worker.pid).join(","));
      const acquire = createWorkerWorkspaceQuiescence({
        ownerSignal: owner.signal,
        sharedHost: false,
        runWorkspaceCommand: (command) =>
          runCommandWithTimeout([process.execPath, ...command.argv.slice(1)], {
            timeoutMs: 10_000,
            baseEnv: input.env,
          }),
      });
      const quiescence = await acquire(input.workspace);
      const directory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leaseFile = path.join(directory, (await fs.readdir(directory))[0]!);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number; start: string }>;
        watchdog: { pid: number };
        expiresAtMs: number;
      };
      watchdogPid = lease.watchdog.pid;
      expect(lease.processes).toHaveLength(workers.length);
      await fs.writeFile(stallPath, "");
      // Publish expiry atomically, like the owner: the watchdog must never see partial JSON.
      const expiredLeaseFile = `${leaseFile}.expired`;
      await fs.writeFile(
        expiredLeaseFile,
        JSON.stringify({ ...lease, expiresAtMs: Date.now() - 1 }),
      );
      await fs.rename(expiredLeaseFile, leaseFile);
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
      expect(exhausted.recoveryError).toContain("recovery exhausted after 4 probe passes");
      expect(exhausted.recoveryError).toContain("retry workspace recovery");
      for (const entry of lease.processes) {
        expect(exhausted.recoveryError).toContain(JSON.stringify(entry));
        expect(await processState(entry.pid)).toMatch(/^T/u);
      }
      await expect(quiescence.resume()).rejects.toThrow(exhausted.recoveryError);
      await fs.unlink(stallPath);
      await quiescence.resume();
      await expect(fs.stat(leaseFile)).rejects.toThrow();
      for (const worker of workers) {
        expect(await processState(worker.pid!)).not.toMatch(/^T/u);
      }
    } finally {
      owner.abort();
      if (watchdogPid !== undefined) {
        try {
          process.kill(watchdogPid, "SIGTERM");
        } catch {
          /* Already retired. */
        }
      }
      await Promise.all(workers.map(stopIdleWorker));
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
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { watchdog: { pid: number } };
      watchdogPid = lease.watchdog.pid;
      expect(await waitForProcessState(child.pid!, /^T/u)).toMatch(/^T/u);
      await fs.writeFile(path.join(input.home, "watchdog-pid"), String(lease.watchdog.pid));

      // ps stays stalled across the failed resume and past lease expiry, so only a
      // watchdog that keeps re-probing identity can still thaw this worker.
      await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);

      const failed = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );
      expect(failed.code).not.toBe(0);

      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const expiredLeaseFile = `${leaseFile}.expired`;
      await fs.writeFile(
        expiredLeaseFile,
        JSON.stringify({ ...lease, expiresAtMs: Date.now() - 1 }),
      );
      await fs.rename(expiredLeaseFile, leaseFile);
      await watchdogProbeTimedOut.promise;
      expect(await processState(child.pid!)).toMatch(/^T/u);
      // An exhausted post-expiry probe must leave the watchdog able to retry recovery.
      expect(() => process.kill(lease.watchdog.pid, 0)).not.toThrow();

      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      connection!.write("retry");

      // SIGCONT precedes lease removal. Wait for the watchdog's terminal state,
      // including an unreaped zombie, before asserting its completed cleanup.
      expect(await waitForProcessState(lease.watchdog.pid, /^(?:Z|$)/u)).toMatch(/^(?:Z|$)/u);
      expect(await processState(child.pid!)).toMatch(/^[^T]/u);
      await expect(fs.stat(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      if (watchdogPid !== undefined) {
        try {
          process.kill(watchdogPid, "SIGTERM");
        } catch {
          // Already retired after recovery.
        }
      }
      connection?.destroy();
      await new Promise<void>((resolve) => {
        probeServer.close(() => resolve());
      });
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  }, 60_000);
});
