import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quiescence-owner-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const probeSlots = path.join(root, "probe-slots");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace), fs.mkdir(bin)]);
  workspace = await fs.realpath(workspace);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nbounded_probe() { slot=""; for n in 1 2 3 4 5 6 7 8; do candidate="$OPENCLAW_TEST_PS_PROBE_SLOTS/$n"; if mkdir "$candidate" 2>/dev/null; then slot=$candidate; break; fi; done; if [ -z "$slot" ]; then exit 75; fi; sleep 0.05; /bin/ps "$@"; status=$?; rmdir "$slot"; exit "$status"; }\ncase "$*" in *"stat=,lstart= -p"*) ;; *"lstart= -p"*) if [ -d "$OPENCLAW_TEST_PS_PROBE_SLOTS" ]; then bounded_probe "$@"; fi ;; esac\ncase "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*|*"args= -p"*) exec /bin/ps "$@" ;; *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)" ;; esac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    bin,
    home,
    workspace,
    probeSlots,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_PROBE_SLOTS: probeSlots,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

async function quiesce(input: Awaited<ReturnType<typeof fixture>>) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
}

async function processStart(pid: number) {
  const result = await runCommandWithTimeout(["ps", "-o", "lstart=", "-p", String(pid)], {
    timeoutMs: 2_000,
  });
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

async function expectProcessState(pid: number, suspended: boolean) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith("T")).toBe(suspended);
    },
    { interval: 50, timeout: 5_000 },
  );
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

async function terminate(child: ChildProcess) {
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

describe("remote workspace quiescence lease ownership", () => {
  it("reclaims a lease mutation lock after its owner is killed", async () => {
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
    const lockPath = `${leaseFile}.lock`;
    const lockHolder = spawn(
      process.execPath,
      [
        "-e",
        'const fs = require("node:fs"); const target = process.argv[1]; const token = "d".repeat(32); process.title = "openclaw-qlease-" + token; fs.mkdirSync(target, { mode: 0o700 }); fs.closeSync(fs.openSync(target + "/owner." + process.pid + "." + token, "wx", 0o600)); setInterval(() => {}, 1000);',
        lockPath,
      ],
      { stdio: "ignore" },
    );
    try {
      const entry = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          version: 1,
          nonce,
          expiresAtMs: Date.now() + 10_000,
          processes: [entry],
        }),
      );
      await vi.waitFor(async () => await expect(fs.access(lockPath)).resolves.toBeUndefined());
      lockHolder.kill("SIGKILL");
      if (lockHolder.exitCode === null) {
        await once(lockHolder, "exit");
      }

      await resume(input, nonce);

      await expectProcessState(childPid, false);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      lockHolder.kill("SIGKILL");
      await terminate(child);
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("reclaims a lease mutation lock after its owner PID is reused", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const lockOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    const lockOwnerPid = lockOwner.pid!;
    const lockPath = `${leaseFile}.lock`;
    try {
      const entry = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          version: 1,
          nonce,
          expiresAtMs: Date.now() + 10_000,
          processes: [entry],
        }),
      );
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, `owner.${lockOwnerPid}.${"e".repeat(32)}`), "", {
        mode: 0o600,
      });

      await resume(input, nonce);

      await expectProcessState(childPid, false);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await expect(fs.access(lockPath)).rejects.toThrow();
      expect(lockOwner.exitCode).toBeNull();
    } finally {
      await terminate(lockOwner);
      await terminate(child);
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("preserves a live lease mutation lock when owner status cannot be observed", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const token = "f".repeat(32);
    const lockOwner = spawn(
      process.execPath,
      ["-e", `process.title = "openclaw-qlease-${token}"; setInterval(() => {}, 1000)`],
      { stdio: "ignore" },
    );
    const lockOwnerPid = lockOwner.pid!;
    const lockPath = `${leaseFile}.lock`;
    try {
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          version: 1,
          nonce,
          expiresAtMs: Date.now() + 60_000,
          processes: [],
        }),
      );
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, `owner.${lockOwnerPid}.${token}`), "", {
        mode: 0o600,
      });
      await fs.writeFile(
        path.join(input.bin, "ps"),
        '#!/bin/sh\ncase "$*" in *"args= -p $OPENCLAW_TEST_PS_STALL_PID"*) exec sleep 10 ;; esac\nexec /bin/ps "$@"\n',
      );

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        {
          timeoutMs: 12_000,
          baseEnv: {
            ...input.env,
            OPENCLAW_TEST_PS_STALL_PID: String(lockOwnerPid),
          },
        },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence lease update timed out");
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      expect(lockOwner.exitCode).toBeNull();
    } finally {
      await terminate(lockOwner);
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("recovers an interrupted empty lease mutation directory", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    const lockPath = `${leaseFile}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.mkdir(`${lockPath}.reclaim`, { mode: 0o700 });

    try {
      await resume(input, nonce);

      await expect(fs.access(leaseFile)).rejects.toThrow();
      await expect(fs.access(lockPath)).rejects.toThrow();
      await expectProcessStopped(lease.watchdog.pid);
    } finally {
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  });

  it("bounds explicit resume identity probe concurrency for large leases", async () => {
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
      const entry = { pid: childPid, start: await processStart(childPid) };
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      process.kill(lease.watchdog.pid, "SIGTERM");
      await expectProcessStopped(lease.watchdog.pid);
      await fs.mkdir(input.probeSlots);
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          ...lease,
          version: 1,
          nonce,
          processes: Array.from({ length: 80 }, () => entry),
          watchdog: null,
          recovery: { state: "probe-timeout", failedAtMs: Date.now() },
        }),
      );

      await resume(input, nonce);

      await expectProcessState(childPid, false);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await expect(fs.readdir(input.probeSlots)).resolves.toEqual([]);
    } finally {
      await terminate(child);
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
    }
  }, 15_000);
});
