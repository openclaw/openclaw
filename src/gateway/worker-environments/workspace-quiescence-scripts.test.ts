import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
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
  const stalledProcessProbeOnceTargetPath = path.join(root, "stall-process-probe-once.target");
  const delayedProcessProbeTargetPath = path.join(root, "delay-process-probe.target");
  const failedProcessProbeTargetPath = path.join(root, "fail-process-probe.target");
  const zombieProcessProbeTargetPath = path.join(root, "zombie-process-probe.target");
  const failedProcessScanPath = path.join(root, "fail-process-scan");
  const failedProcessScanStatePath = path.join(root, "fail-process-scan.state");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nstall() { printf "%s\\n" "$$" >> "$OPENCLAW_TEST_PS_STALL_PID"; trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL" ]; then rm -f "$OPENCLAW_TEST_PS_STALL"; stall; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET"; then rm -f "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET"; stall; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_DELAY_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_DELAY_TARGET"; then sleep 0.9; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_FAIL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_FAIL_TARGET"; then exit 2; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_ZOMBIE_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_ZOMBIE_TARGET"; then start=$(/bin/ps -o lstart= -p "$target"); if [ -n "$start" ]; then printf "Z %s\\n" "$start"; exit 0; fi; fi ;; esac; fi\ncase "$*" in *"pid=,ppid=,uid=,stat=,lstart="*) if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN.seen" ]; then extra_pid=$(head -n 1 "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o stat= -p "$extra_pid" > "$OPENCLAW_TEST_PS_FAIL_SCAN_STATE"; exit 2; fi ;; esac\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then while IFS= read -r extra_pid; do [ -n "$extra_pid" ] && /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid"; done < "$OPENCLAW_TEST_PS_EXTRA"; fi; if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN" ]; then touch "$OPENCLAW_TEST_PS_FAIL_SCAN.seen"; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    bin,
    home,
    workspace,
    extraProcessPath,
    stalledProcessProbePath,
    stalledProcessProbePidPath,
    stalledProcessProbeTargetPath,
    stalledProcessProbeOnceTargetPath,
    delayedProcessProbeTargetPath,
    failedProcessProbeTargetPath,
    zombieProcessProbeTargetPath,
    failedProcessScanPath,
    failedProcessScanStatePath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      OPENCLAW_TEST_PS_STALL: stalledProcessProbePath,
      OPENCLAW_TEST_PS_STALL_PID: stalledProcessProbePidPath,
      OPENCLAW_TEST_PS_STALL_TARGET: stalledProcessProbeTargetPath,
      OPENCLAW_TEST_PS_STALL_ONCE_TARGET: stalledProcessProbeOnceTargetPath,
      OPENCLAW_TEST_PS_DELAY_TARGET: delayedProcessProbeTargetPath,
      OPENCLAW_TEST_PS_FAIL_TARGET: failedProcessProbeTargetPath,
      OPENCLAW_TEST_PS_ZOMBIE_TARGET: zombieProcessProbeTargetPath,
      OPENCLAW_TEST_PS_FAIL_SCAN: failedProcessScanPath,
      OPENCLAW_TEST_PS_FAIL_SCAN_STATE: failedProcessScanStatePath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

async function useBatchedDelayedProcessFixture(input: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(
    path.join(input.bin, "ps"),
    '#!/bin/sh\nstall() { trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi ;; esac; fi\ncase "$*" in\n  *"pid=,ppid=,uid=,stat=,lstart="*) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -s "$OPENCLAW_TEST_PS_EXTRA" ]; then pids=$(paste -sd, "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$pids"; fi ;;\n  *"stat=,lstart= -p"*|*"lstart= -p"*) target=""; for argument in "$@"; do target=$argument; done; if [ -f "$OPENCLAW_TEST_PS_DELAY_TARGET" ] && grep -qx "$target" "$OPENCLAW_TEST_PS_DELAY_TARGET"; then /bin/sleep 0.7; fi; exec /bin/ps "$@" ;;\nesac\n',
  );
}

async function quiesce(
  input: Awaited<ReturnType<typeof fixture>>,
  watchdogTimeoutMs = 10_000,
  commandTimeoutMs = 10_000,
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      input.workspace,
      String(watchdogTimeoutMs),
    ],
    { timeoutMs: commandTimeoutMs, baseEnv: input.env },
  );
  expect(result.code, result.stderr).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

async function processStart(pid: number) {
  const result = await runCommandWithTimeout(["ps", "-o", "lstart=", "-p", String(pid)], {
    timeoutMs: 2_000,
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function expectProcessState(pid: number, suspended: boolean, timeout = 5_000) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith("T")).toBe(suspended);
    },
    { interval: 50, timeout },
  );
}

async function expectProcessExited(pid: number, timeout = 5_000) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code !== 0 || /^[ZX]/u.test(result.stdout.trim())).toBe(true);
    },
    { interval: 50, timeout },
  );
}

async function terminate(child: ReturnType<typeof spawn>) {
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGCONT");
    } catch {}
  }
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
  expect(result.code).toBe(0);
}

async function renew(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  commandTimeoutMs = 10_000,
) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce, "20000"],
    { timeoutMs: commandTimeoutMs, baseEnv: input.env },
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
    await expectProcessExited(lease.watchdog.pid);
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
    await expectProcessExited(firstLease.watchdog.pid);
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
      await expectProcessState(childPid, false);
      const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leases = (await fs.readdir(leaseDirectory)).filter((name) => name.endsWith(".json"));
      expect(leases).toEqual([]);
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.failedProcessScanPath, { force: true });
      await fs.rm(`${input.failedProcessScanPath}.seen`, { force: true });
      await terminate(child);
    }
  }, 15_000);

  it("reaches terminal recovery within one global deadline across persistent probe batches", async () => {
    const input = await fixture();
    const children = Array.from({ length: 24 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      nonce = await quiesce(input, 30_000, 20_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${childPids.join("\n")}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      const terminal = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as {
        watchdog: unknown;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toBeNull();
      expect(terminal.processes.map((entry) => entry.pid)).toEqual(childPids);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, false)));
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 35_000);

  it("reports when failed quiescence recovery retains a terminal lease", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      await fs.writeFile(input.failedProcessScanPath, "fail after first scan\n");
      await fs.writeFile(input.failedProcessProbeTargetPath, `${childPid}\n`);

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "workspace quiescence recovery failed; lease retained for operator recovery",
      );
      const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leases = (await fs.readdir(leaseDirectory)).filter((name) => name.endsWith(".json"));
      expect(leases).toHaveLength(1);
      const terminal = JSON.parse(
        await fs.readFile(path.join(leaseDirectory, leases[0]!), "utf8"),
      ) as {
        nonce: string;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      nonce = terminal.nonce;
      expect(terminal.processes.map((entry) => entry.pid)).toEqual([childPid]);
      expect(terminal.recovery?.state).toBe("recovery-failed");

      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
      await expectProcessState(childPid, false);
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      await fs.rm(input.failedProcessScanPath, { force: true });
      await fs.rm(`${input.failedProcessScanPath}.seen`, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
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

    await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${before.watchdog.pid}\n`);
    await renew(input, nonce);
    await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();

    const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
    };
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
    await resume(input, nonce);
  });

  it("rejects renewal when the watchdog identity is a zombie", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 30_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number };
    };

    try {
      await fs.writeFile(input.zombieProcessProbeTargetPath, `${before.watchdog.pid}\n`);
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "60000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog is not active");
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
    } finally {
      await fs.rm(input.zombieProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
    }
  });

  it("rejects renewal when the watchdog is stopped", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 30_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number };
    };

    try {
      process.kill(before.watchdog.pid, "SIGSTOP");
      await expectProcessState(before.watchdog.pid, true);
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "60000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog is not active");
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
    } finally {
      try {
        process.kill(before.watchdog.pid, "SIGCONT");
      } catch {}
      await resume(input, nonce);
    }
  });

  it("allows healthy high-cardinality enrollment to use a bounded count-aware deadline", async () => {
    const input = await fixture();
    await useBatchedDelayedProcessFixture(input);
    const children = Array.from({ length: 64 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      await fs.writeFile(input.delayedProcessProbeTargetPath, `${childPids.join("\n")}\n`);

      nonce = await quiesce(input, 30_000, 30_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      await renew(input, nonce, 30_000);
    } finally {
      await fs.rm(input.delayedProcessProbeTargetPath, { force: true });
      await fs.rm(input.extraProcessPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 60_000);

  it("rejects renewal before high-cardinality validation can outlive the lease", async () => {
    const input = await fixture();
    await useBatchedDelayedProcessFixture(input);
    const children = Array.from({ length: 64 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      nonce = await quiesce(input, 20_000, 30_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        watchdog: { pid: number };
      };
      const waitMs = before.expiresAtMs - Date.now() - 11_000;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, waitMs);
        });
      }
      await fs.writeFile(input.delayedProcessProbeTargetPath, `${childPids.join("\n")}\n`);
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${before.watchdog.pid}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
        ],
        { timeoutMs: 20_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence lease is no longer active");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
    } finally {
      await fs.rm(input.delayedProcessProbeTargetPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await fs.rm(input.extraProcessPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 60_000);

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
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${child.pid}\n`);
      await renew(input, nonce);

      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${child.pid}\n`);
      await renew(input, nonce);
      await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();
    } finally {
      await resume(input, nonce);
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeOnceTargetPath, { force: true });
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

  it("retries a transient stalled process probe during explicit resume", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      nonce = await quiesce(input);
      await expectProcessState(childPid, true);
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${childPid}\n`);

      await resume(input, nonce);

      await expectProcessState(childPid, false);
      await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();
      await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeOnceTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 15_000);

  it("records a watchdog probe timeout while resuming healthy processes", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      nonce = await quiesce(input, 30_000, 20_000);
      await expectProcessState(childPid, true);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
      };
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${lease.watchdog.pid}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence recovery timed out");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      await expectProcessState(childPid, false);
      const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toEqual(lease.watchdog);
      expect(terminal.processes).toEqual([]);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 15_000);

  it("retries a signal-resistant stalled watchdog process probe before releasing the lease", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
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
          stalledPid = Number((await fs.readFile(input.stalledProcessProbePidPath, "utf8")).trim());
          expect(stalledPid).toBeGreaterThan(0);
        },
        { interval: 50, timeout: 2_500 },
      );
      await vi.waitFor(
        async () => {
          await expect(fs.access(leaseFile)).rejects.toThrow();
        },
        { interval: 50, timeout: 4_000 },
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
  }, 6_000);

  it.each([
    {
      probePath: "stalledProcessProbeTargetPath" as const,
      recoveryState: "probe-timeout",
      message: "workspace quiescence recovery timed out",
      healthyCount: 1,
    },
    {
      probePath: "failedProcessProbeTargetPath" as const,
      recoveryState: "recovery-failed",
      message: "workspace quiescence recovery failed",
      healthyCount: 9,
    },
  ])(
    "records $recoveryState without blocking identity-matched processes",
    async ({ probePath, recoveryState, message, healthyCount }) => {
      const input = await fixture();
      const nonce = await quiesce(input, 30_000);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
      };
      const children = Array.from({ length: healthyCount + 1 }, () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      );
      const childPids = children.map((child) => child.pid!);
      const stalledPid = childPids[0]!;
      const healthyPids = childPids.slice(1);
      const targetPath = input[probePath];

      try {
        const entries = await Promise.all(
          childPids.map(async (pid) => ({ pid, start: await processStart(pid) })),
        );
        childPids.forEach((pid) => process.kill(pid, "SIGSTOP"));
        await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
        await fs.writeFile(
          leaseFile,
          JSON.stringify({
            ...lease,
            expiresAtMs: Date.now() + 1_000,
            processes: entries,
          }),
        );
        await fs.writeFile(targetPath, `${stalledPid}\n`);

        const recoveryResult = await runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
          { timeoutMs: 10_000, baseEnv: input.env },
        );
        expect(recoveryResult.code).not.toBe(0);
        expect(recoveryResult.stderr).toContain(message);
        await Promise.all(
          healthyPids.map(async (pid) => await expectProcessState(pid, false, 8_000)),
        );
        await vi.waitFor(
          async () => {
            const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
              watchdog: unknown;
              processes: Array<{ pid: number }>;
              recovery?: { state: string; failedAtMs: number };
            };
            expect(terminal.watchdog).toBeNull();
            expect(terminal.processes.map((entry) => entry.pid)).toEqual([stalledPid]);
            expect(terminal.recovery).toMatchObject({
              state: recoveryState,
              failedAtMs: expect.any(Number),
            });
          },
          { interval: 50, timeout: 8_000 },
        );
        await expectProcessState(stalledPid, true);

        const renewResult = await runCommandWithTimeout(
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
        expect(renewResult.code).not.toBe(0);
        expect(renewResult.stderr).toContain(message);

        const failedResume = await runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
          { timeoutMs: 8_000, baseEnv: input.env },
        );
        expect(failedResume.code).not.toBe(0);
        expect(failedResume.stderr).toContain(message);
        await expect(fs.access(leaseFile)).resolves.toBeUndefined();

        await fs.rm(targetPath, { force: true });
        await resume(input, nonce);
        await expectProcessState(stalledPid, false);
        await expect(fs.access(leaseFile)).rejects.toThrow();
      } finally {
        await fs.rm(targetPath, { force: true });
        try {
          await resume(input, nonce);
        } catch {}
        try {
          process.kill(lease.watchdog.pid, "SIGKILL");
        } catch {}
        await Promise.all(children.map(async (child) => await terminate(child)));
      }
    },
    20_000,
  );
});
