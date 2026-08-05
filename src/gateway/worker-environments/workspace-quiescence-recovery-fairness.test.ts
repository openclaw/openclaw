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
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quiescence-fairness-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const stalledProcessProbeTargetPath = path.join(root, "stall-process-probe.target");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace), fs.mkdir(bin)]);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nstall() { trap "" TERM; exec sleep 30; }\ntarget=""; for argument in "$@"; do target=$argument; done\ncase "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ] && { grep -qx "*" "$OPENCLAW_TEST_PS_STALL_TARGET" || grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; }; then stall; fi ;; esac\nexec /bin/ps "$@"\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    home,
    workspace: await fs.realpath(workspace),
    stalledProcessProbeTargetPath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_STALL_TARGET: stalledProcessProbeTargetPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
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

async function writeLease(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  pids: number[],
) {
  const file = leasePath(input.home, input.workspace, nonce);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const processes = await Promise.all(
    pids.map(async (pid) => ({ pid, start: await processStart(pid) })),
  );
  await fs.writeFile(
    file,
    `${JSON.stringify({
      version: 1,
      nonce,
      processes,
      watchdog: null,
      expiresAtMs: Date.now() + 30_000,
    })}\n`,
  );
  return file;
}

async function writeSyntheticLease(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  firstPid: number,
) {
  const file = leasePath(input.home, input.workspace, nonce);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const processes = Array.from({ length: 4_096 }, (_, index) => ({
    pid: firstPid + index,
    start: `synthetic-${firstPid + index}`,
  }));
  await fs.writeFile(
    file,
    `${JSON.stringify({
      version: 1,
      nonce,
      processes,
      watchdog: { pid: firstPid + processes.length, start: `synthetic-watchdog-${firstPid}` },
      expiresAtMs: Date.now() + 30_000,
    })}\n`,
  );
  return file;
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  return await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
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

describe("workspace quiescence recovery fairness", () => {
  it("rotates timed-out references behind deferred work across recovery passes", async () => {
    const input = await fixture();
    const stalledChildren = Array.from({ length: 40 }, () =>
      spawn("sleep", ["30"], { stdio: "ignore" }),
    );
    const healthyChild = spawn("sleep", ["30"], { stdio: "ignore" });
    const stalledPids = stalledChildren.map((child) => child.pid!);
    const healthyPid = healthyChild.pid!;
    const nonce = "a".repeat(32);

    try {
      for (const pid of [...stalledPids, healthyPid]) {
        process.kill(pid, "SIGSTOP");
      }
      await Promise.all(
        [...stalledPids, healthyPid].map(async (pid) => await expectProcessState(pid, true)),
      );
      const leaseFile = await writeLease(input, nonce, [...stalledPids, healthyPid]);
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${stalledPids.join("\n")}\n`);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await resume(input, nonce)).code).not.toBe(0);
      }

      await expectProcessState(healthyPid, false);
      const retained = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number }>;
      };
      expect(retained.processes.map((entry) => entry.pid)).not.toContain(healthyPid);
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      expect((await resume(input, nonce)).code).toBe(0);
      await Promise.all(stalledPids.map(async (pid) => await expectProcessState(pid, false)));
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
      await Promise.all(
        [...stalledChildren, healthyChild].map(async (child) => await terminate(child)),
      );
    }
  }, 45_000);

  it("round-robins orphan recovery past a persistently stalled lease", async () => {
    const input = await fixture();
    const stalledChildren = Array.from({ length: 40 }, () =>
      spawn("sleep", ["30"], { stdio: "ignore" }),
    );
    const healthyChild = spawn("sleep", ["30"], { stdio: "ignore" });
    const stalledPids = stalledChildren.map((child) => child.pid!);
    const healthyPid = healthyChild.pid!;
    let stalledNonce = "";

    try {
      for (const pid of [...stalledPids, healthyPid]) {
        process.kill(pid, "SIGSTOP");
      }
      await Promise.all(
        [...stalledPids, healthyPid].map(async (pid) => await expectProcessState(pid, true)),
      );
      const nonces = ["0".repeat(32), "f".repeat(32)];
      for (const nonce of nonces) {
        await writeLease(input, nonce, []);
      }
      const directory = path.dirname(leasePath(input.home, input.workspace, nonces[0]!));
      const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
      stalledNonce = names[0]!.split(".")[1]!;
      const healthyNonce = names[1]!.split(".")[1]!;
      await writeLease(input, stalledNonce, stalledPids);
      await writeLease(input, healthyNonce, [healthyPid]);
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${stalledPids.join("\n")}\n`);

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence orphan recovery timed out");
      await expectProcessState(healthyPid, false);
      await expect(
        fs.access(leasePath(input.home, input.workspace, healthyNonce)),
      ).rejects.toThrow();
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      expect((await resume(input, stalledNonce)).code).toBe(0);
      await Promise.all(stalledPids.map(async (pid) => await expectProcessState(pid, false)));
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (stalledNonce) {
        await resume(input, stalledNonce);
      }
      await Promise.all(
        [...stalledChildren, healthyChild].map(async (child) => await terminate(child)),
      );
    }
  }, 30_000);

  it("partitions maximum orphan recovery without linear membership scans", async () => {
    const input = await fixture();
    const leaseFiles = await Promise.all(
      Array.from(
        { length: 16 },
        async (_, index) =>
          await writeSyntheticLease(
            input,
            index.toString(16).padStart(32, "0"),
            10_000 + index * 5_000,
          ),
      ),
    );
    await fs.writeFile(input.stalledProcessProbeTargetPath, "*\n");
    const instrumentedScript = `
const originalArrayIncludes = Array.prototype.includes;
Array.prototype.includes = function (...args) {
  const first = this[0];
  const value = args[0];
  if (first && typeof first === "object" && "signal" in first && value && typeof value === "object" && "signal" in value) {
    throw new Error("quadratic orphan reference membership scan");
  }
  return Reflect.apply(originalArrayIncludes, this, args);
};
${REMOTE_WORKSPACE_QUIESCE_JS}`;

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", instrumentedScript, input.workspace, "10000"],
      { timeoutMs: 12_000, baseEnv: input.env },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("quadratic orphan reference membership scan");
    expect(result.stderr).toContain("workspace quiescence orphan recovery timed out");
    const retained = await Promise.all(
      leaseFiles.map(
        async (file) =>
          JSON.parse(await fs.readFile(file, "utf8")) as {
            processes: Array<{ pid: number }>;
            watchdog: { pid: number } | null;
            recovery?: { state: string };
          },
      ),
    );
    expect(retained).toHaveLength(16);
    expect(retained.every((lease) => lease.processes.length === 4_096)).toBe(true);
    expect(retained.every((lease) => lease.watchdog !== null)).toBe(true);
    expect(retained.every((lease) => lease.recovery?.state === "probe-timeout")).toBe(true);
  }, 20_000);
});
