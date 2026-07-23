import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS } from "./workspace-quiescence-script-runtime.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quiescence-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  const stalledProcessProbePath = path.join(root, "stall-process-probe");
  const stalledProcessProbePidPath = path.join(root, "stall-process-probe.pid");
  const stalledProcessProbeTargetPath = path.join(root, "stall-process-probe.target");
  const failedProcessProbeTargetPath = path.join(root, "fail-process-probe.target");
  const failedProcessScanPath = path.join(root, "fail-process-scan");
  const failedProcessScanStatePath = path.join(root, "fail-process-scan.state");
  const delayedProcessIdentityTargetPath = path.join(root, "delay-process-identity.target");
  const delayedProcessStatusPath = path.join(root, "delay-process-status");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nstall() { printf "%s\\n" "$$" > "$OPENCLAW_TEST_PS_STALL_PID"; trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL" ]; then rm -f "$OPENCLAW_TEST_PS_STALL"; stall; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi; fi\ncase "$*" in *"pid=,ppid=,uid=,stat=,lstart="*) if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN.seen" ]; then extra_pid=$(cat "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o stat= -p "$extra_pid" > "$OPENCLAW_TEST_PS_FAIL_SCAN_STATE"; exit 2; fi ;; esac\ncase "$*" in *"stat=,lstart= -p"*) target=""; for argument in "$@"; do target=$argument; done; if [ -f "$OPENCLAW_TEST_PS_STATUS_DELAY" ] && grep -qx "$target" "$OPENCLAW_TEST_PS_STATUS_DELAY"; then sleep 1.5; fi ;; esac\nif [ -f "$OPENCLAW_TEST_PS_FAIL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*) ;; *"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_FAIL_TARGET"; then exit 2; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_IDENTITY_DELAY_TARGET" ]; then target=$(cat "$OPENCLAW_TEST_PS_IDENTITY_DELAY_TARGET"); case "$*" in *"stat=,lstart= -p"*) ;; *"lstart= -p $target"*) sleep 0.75 ;; esac; fi\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*|*"args= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then extra_pid=$(cat "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid"; fi; if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN" ]; then touch "$OPENCLAW_TEST_PS_FAIL_SCAN.seen"; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    home,
    workspace,
    extraProcessPath,
    stalledProcessProbePath,
    stalledProcessProbePidPath,
    stalledProcessProbeTargetPath,
    failedProcessProbeTargetPath,
    failedProcessScanPath,
    failedProcessScanStatePath,
    delayedProcessIdentityTargetPath,
    delayedProcessStatusPath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      OPENCLAW_TEST_PS_STALL: stalledProcessProbePath,
      OPENCLAW_TEST_PS_STALL_PID: stalledProcessProbePidPath,
      OPENCLAW_TEST_PS_STALL_TARGET: stalledProcessProbeTargetPath,
      OPENCLAW_TEST_PS_FAIL_TARGET: failedProcessProbeTargetPath,
      OPENCLAW_TEST_PS_FAIL_SCAN: failedProcessScanPath,
      OPENCLAW_TEST_PS_FAIL_SCAN_STATE: failedProcessScanStatePath,
      OPENCLAW_TEST_PS_IDENTITY_DELAY_TARGET: delayedProcessIdentityTargetPath,
      OPENCLAW_TEST_PS_STATUS_DELAY: delayedProcessStatusPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

async function quiesce(input: Awaited<ReturnType<typeof fixture>>, watchdogTimeoutMs = 10_000) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      input.workspace,
      String(watchdogTimeoutMs),
    ],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

async function expectProcessStopped(pid: number) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code === 1 || result.stdout.trim().startsWith("Z")).toBe(true);
    },
    { interval: 50, timeout: 5_000 },
  );
}

async function processStart(pid: number) {
  const result = await runCommandWithTimeout(["ps", "-o", "lstart=", "-p", String(pid)], {
    timeoutMs: 2_000,
  });
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

async function expectProcessResumed(pid: number, timeout = 5_000) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith("T")).toBe(false);
    },
    { interval: 50, timeout },
  );
}

async function expectProcessSuspended(pid: number) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith("T")).toBe(true);
    },
    { interval: 50, timeout: 5_000 },
  );
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
}

async function renew(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce, "20000"],
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
    await expectProcessStopped(lease.watchdog.pid);
  });

  it("recovers a prior nonce without letting its watchdog own the next lease", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input);
    const firstLease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, firstNonce), "utf8"),
    ) as { watchdog: { pid: number; start: string } };

    const secondNonce = await quiesce(input);

    expect(secondNonce).not.toBe(firstNonce);
    await expect(fs.access(leasePath(input.home, input.workspace, firstNonce))).rejects.toThrow();
    await expect(
      fs.access(leasePath(input.home, input.workspace, secondNonce)),
    ).resolves.toBeUndefined();
    await expectProcessStopped(firstLease.watchdog.pid);
    await resume(input, secondNonce);
  });

  it("uses bounded recovery when quiescence fails after stopping a process", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      await fs.writeFile(input.failedProcessScanPath, "fail after first scan\n");

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(
        (await fs.readFile(input.failedProcessScanStatePath, "utf8")).trim().startsWith("T"),
      ).toBe(true);
      await expectProcessResumed(childPid);
      const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leases = (await fs.readdir(leaseDirectory)).filter((name) => name.endsWith(".json"));
      expect(leases).toEqual([]);
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.failedProcessScanPath, { force: true });
      await fs.rm(`${input.failedProcessScanPath}.seen`, { force: true });
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 15_000);

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

  it(
    "retries a signal-resistant stalled watchdog process probe before releasing the lease",
    async () => {
      const input = await fixture();
      const nonce = await quiesce(input, 1_000);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        nonce: string;
        processes: Array<{ pid: number; start: string }>;
        watchdog: { pid: number; start: string };
      };
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          expiresAtMs: Date.now() + 1_000,
          processes: [{ pid: process.pid, start: await processStart(process.pid) }],
        }),
      );
      await fs.writeFile(input.stalledProcessProbePath, "stall\n");

      let stalledPid = 0;
      try {
        await vi.waitFor(
          async () => {
            stalledPid = Number(
              (await fs.readFile(input.stalledProcessProbePidPath, "utf8")).trim(),
            );
            expect(stalledPid).toBeGreaterThan(0);
          },
          { interval: 50, timeout: 2_500 },
        );
        await vi.waitFor(
          async () => {
            await expect(fs.access(leaseFile)).rejects.toThrow();
          },
          { interval: 50, timeout: REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS + 2_000 },
        );
      } finally {
        try {
          process.kill(lease.watchdog.pid, "SIGKILL");
        } catch {}
        if (stalledPid > 0) {
          try {
            process.kill(stalledPid, "SIGKILL");
          } catch {}
        }
      }
    },
    REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS + 4_000,
  );

  it("serializes renewal against watchdog recovery before resuming processes", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
    );

    try {
      const entries = await Promise.all(
        children.map(async (child) => {
          expect(child.pid).toBeDefined();
          const pid = child.pid!;
          const start = await processStart(pid);
          process.kill(pid, "SIGSTOP");
          await expectProcessSuspended(pid);
          return { pid, start };
        }),
      );
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          version: 1,
          nonce,
          expiresAtMs: Date.now() + 5_800,
          processes: entries,
        }),
      );
      await fs.writeFile(
        input.delayedProcessStatusPath,
        `${entries.map((entry) => entry.pid).join("\n")}\n`,
      );
      await fs.writeFile(input.delayedProcessIdentityTargetPath, `${entries[0]!.pid}\n`);

      const renewal = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
          "heartbeat",
        ],
        { timeoutMs: 12_000, baseEnv: input.env },
      );

      expect(renewal.code).not.toBe(0);
      await expectProcessResumed(entries[0]!.pid);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await expectProcessStopped(lease.watchdog.pid);
    } finally {
      for (const child of children) {
        if (!child.pid) {
          continue;
        }
        try {
          process.kill(child.pid, "SIGCONT");
        } catch {}
        child.kill("SIGTERM");
        if (child.exitCode === null) {
          await once(child, "exit");
        }
      }
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 30_000);

  it("drains in-flight recovery probes before a failed entry releases the lease lock", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
    );

    try {
      const entries = await Promise.all(
        children.map(async (child) => {
          const pid = child.pid!;
          const start = await processStart(pid);
          process.kill(pid, "SIGSTOP");
          await expectProcessSuspended(pid);
          return { pid, start };
        }),
      );
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          expiresAtMs: Date.now() + 5_800,
          processes: entries,
        }),
      );
      await fs.writeFile(
        input.delayedProcessStatusPath,
        `${entries.map((entry) => entry.pid).join("\n")}\n`,
      );
      await fs.writeFile(input.failedProcessProbeTargetPath, `${entries[0]!.pid}\n`);
      await fs.writeFile(input.delayedProcessIdentityTargetPath, `${entries[1]!.pid}\n`);

      const renewal = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
          "heartbeat",
        ],
        { timeoutMs: 12_000, baseEnv: input.env },
      );

      expect(renewal.code).not.toBe(0);
      await expectProcessResumed(entries[1]!.pid);
      const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: unknown;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toBeNull();
      expect(terminal.processes.map((entry) => entry.pid)).toEqual([entries[0]!.pid]);
      expect(terminal.recovery?.state).toBe("recovery-failed");
    } finally {
      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      await fs.rm(input.delayedProcessIdentityTargetPath, { force: true });
      await fs.rm(input.delayedProcessStatusPath, { force: true });
      try {
        await resume(input, nonce);
      } catch {}
      for (const child of children) {
        child.kill("SIGCONT");
        child.kill("SIGTERM");
        if (child.exitCode === null) {
          await once(child, "exit");
        }
      }
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 30_000);

  it("bounds orphan recovery and retains entries whose identity probe stays stalled", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;

    try {
      const stalled = { pid: process.pid, start: await processStart(process.pid) };
      const healthy = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessSuspended(childPid);
      process.kill(lease.watchdog.pid, "SIGTERM");
      await expectProcessStopped(lease.watchdog.pid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          processes: [stalled, healthy],
          watchdog: null,
          recovery: { state: "probe-timeout", failedAtMs: Date.now() },
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${stalled.pid}\n`);

      const startedAt = Date.now();
      const nextQuiesce = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(nextQuiesce.code).not.toBe(0);
      expect(nextQuiesce.stderr).toContain("orphan recovery timed out");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      await expectProcessResumed(childPid);
      const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: unknown;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toBeNull();
      expect(terminal.processes.map((entry) => entry.pid)).toEqual([stalled.pid]);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 15_000);

  it("records a bounded recovery failure without blocking identity-matched entries", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      nonce: string;
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    const childPid = child.pid!;

    try {
      process.kill(childPid, "SIGSTOP");
      await expectProcessSuspended(childPid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          expiresAtMs: Date.now() + 1_000,
          processes: [
            { pid: process.pid, start: await processStart(process.pid) },
            { pid: childPid, start: await processStart(childPid) },
          ],
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${process.pid}\n`);

      await expectProcessResumed(childPid);
      await vi.waitFor(
        async () => {
          const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
            watchdog: unknown;
            processes: Array<{ pid: number }>;
            recovery?: { state: string; failedAtMs: number };
          };
          expect(terminal.watchdog).toBeNull();
          expect(terminal.processes).toEqual([
            { pid: process.pid, start: await processStart(process.pid) },
          ]);
          expect(terminal.recovery).toMatchObject({ state: "probe-timeout" });
          expect(terminal.recovery?.failedAtMs).toEqual(expect.any(Number));
        },
        { interval: 50, timeout: 8_000 },
      );

      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence recovery timed out");

      const resumeResult = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 3_000, baseEnv: input.env },
      );
      expect(resumeResult.code).not.toBe(0);
      expect(resumeResult.stderr).toContain("workspace quiescence recovery timed out");
      await expect(fs.access(leaseFile)).resolves.toBeUndefined();

      await fs.rm(input.stalledProcessProbeTargetPath);
      await resume(input, nonce);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 12_000);

  it("resumes healthy watchdog entries despite an earlier stalled probe batch", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;

    try {
      const stalled = { pid: process.pid, start: await processStart(process.pid) };
      const healthy = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessSuspended(childPid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          expiresAtMs: Date.now() + 1_000,
          processes: [...Array.from({ length: 6 }, () => stalled), healthy],
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${process.pid}\n`);

      await expectProcessResumed(childPid);
      await vi.waitFor(
        async () => {
          const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
            processes: Array<{ pid: number }>;
            recovery?: { state: string };
          };
          expect(terminal.processes).toHaveLength(6);
          expect(terminal.processes.every((entry) => entry.pid === process.pid)).toBe(true);
          expect(terminal.recovery?.state).toBe("probe-timeout");
        },
        { interval: 50, timeout: 8_000 },
      );
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 12_000);

  it("returns a failure exit code when explicit resume rejects in warning mode", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const stalled = { pid: process.pid, start: await processStart(process.pid) };

    try {
      process.kill(lease.watchdog.pid, "SIGTERM");
      await expectProcessStopped(lease.watchdog.pid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          processes: [stalled],
          watchdog: null,
          recovery: { state: "probe-timeout", failedAtMs: Date.now() },
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${process.pid}\n`);

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        {
          timeoutMs: 10_000,
          baseEnv: { ...input.env, NODE_OPTIONS: "--unhandled-rejections=warn" },
        },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "workspace quiescence recovery timed out; lease retained for operator recovery",
      );
      const retained = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(retained.processes).toEqual([{ pid: process.pid, start: stalled.start }]);
      expect(retained.recovery?.state).toBe("probe-timeout");
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 12_000);

  it("signals each explicit-resume entry as soon as its bounded probe completes", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let resumeProcess: ReturnType<typeof spawn> | undefined;

    try {
      const healthy = { pid: childPid, start: await processStart(childPid) };
      const stalled = { pid: process.pid, start: await processStart(process.pid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessSuspended(childPid);
      process.kill(lease.watchdog.pid, "SIGTERM");
      await expectProcessStopped(lease.watchdog.pid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          processes: [healthy, ...Array.from({ length: 80 }, () => stalled)],
          watchdog: null,
          recovery: { state: "probe-timeout", failedAtMs: Date.now() },
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${process.pid}\n`);
      resumeProcess = spawn(
        process.execPath,
        ["-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { env: input.env, stdio: "ignore" },
      );

      await expectProcessResumed(childPid, 1_500);
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      const code =
        resumeProcess.exitCode ?? ((await once(resumeProcess, "exit")) as [number | null])[0];
      expect(code).not.toBe(0);
      await expect(fs.access(leaseFile)).resolves.toBeUndefined();
      await resume(input, nonce);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      resumeProcess?.kill("SIGKILL");
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 12_000);

  it("rotates deferred entries ahead of timed-out probes for the next resume", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let resumeProcess: ReturnType<typeof spawn> | undefined;

    try {
      const stalled = Array.from({ length: 40 }, (_, index) => ({
        pid: 9_000_000 + index,
        start: `stalled-${index}`,
      }));
      const healthy = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessSuspended(childPid);
      process.kill(lease.watchdog.pid, "SIGTERM");
      await expectProcessStopped(lease.watchdog.pid);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          processes: [...stalled, healthy],
          watchdog: null,
          recovery: { state: "probe-timeout", failedAtMs: Date.now() },
        }),
      );
      await fs.writeFile(
        input.stalledProcessProbeTargetPath,
        `${stalled.map((entry) => entry.pid).join("\n")}\n`,
      );

      const firstAttempt = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(firstAttempt.code).not.toBe(0);
      const retained = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number }>;
      };
      expect(retained.processes[0]?.pid).toBe(childPid);

      resumeProcess = spawn(
        process.execPath,
        ["-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { env: input.env, stdio: "ignore" },
      );
      await expectProcessResumed(childPid, 1_500);
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      const code =
        resumeProcess.exitCode ?? ((await once(resumeProcess, "exit")) as [number | null])[0];
      expect(code).not.toBe(0);
      await resume(input, nonce);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      resumeProcess?.kill("SIGKILL");
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  }, 20_000);

  it("does not scan stalled entries past the watchdog recovery budget", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const entry = { pid: process.pid, start: await processStart(process.pid) };

    try {
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          expiresAtMs: Date.now() + 1_000,
          processes: Array.from({ length: 8 }, () => entry),
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${process.pid}\n`);
      await vi.waitFor(
        async () => {
          expect(
            Number((await fs.readFile(input.stalledProcessProbePidPath, "utf8")).trim()),
          ).toBeGreaterThan(0);
        },
        { interval: 50, timeout: 2_500 },
      );
      const startedAtMs = Date.now();
      await vi.waitFor(
        async () => {
          const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
            recovery?: { failedAtMs: number };
          };
          expect(terminal.recovery?.failedAtMs).toEqual(expect.any(Number));
          expect(terminal.recovery!.failedAtMs - startedAtMs).toBeLessThan(6_500);
        },
        { interval: 50, timeout: 8_000 },
      );
    } finally {
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 10_000);
});
