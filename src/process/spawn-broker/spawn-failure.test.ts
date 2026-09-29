import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const execFileAsync = promisify(execFile);

async function openDescriptorCount(pid: number): Promise<number> {
  if (process.platform === "linux") {
    return (await readdir(`/proc/${pid}/fd`)).length;
  }
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-Ff"]);
  return stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length;
}

async function runValidCommand(host: SpawnBrokerHost): Promise<void> {
  const child = host.spawn(process.execPath, ["-e", "process.stdout.write('ok')"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  await child.ready();
  let stdout = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  await closed;
  expect(stdout).toBe("ok");
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "spawn broker failed launch cleanup",
  () => {
    it.skipIf(Boolean(process.versions.bun))(
      "releases native descriptors after missing executable and cwd failures",
      async () => {
        const host = createSpawnBrokerHost();
        const missing = path.join(tmpdir(), `openclaw-missing-spawn-${process.pid}`);
        try {
          await host.ready();
          await runValidCommand(host);
          const before = await openDescriptorCount(host.pid!);
          for (let attempt = 0; attempt < 24; attempt += 1) {
            const invalidCwd = attempt % 2 === 1;
            const child = host.spawn(invalidCwd ? process.execPath : missing, [], {
              ...(invalidCwd ? { cwd: missing } : {}),
              stdio:
                attempt % 4 < 2 ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
            });
            const closed = new Promise<void>((resolve) => {
              child.once("close", () => resolve());
            });
            await expect(child.ready()).rejects.toMatchObject({ code: "ENOENT" });
            await closed;
          }
          await runValidCommand(host);
          expect(await openDescriptorCount(host.pid!)).toBe(before);
        } finally {
          await host.close();
        }
      },
    );

    it.skipIf(process.platform !== "linux" || Boolean(process.versions.bun))(
      "preserves EMFILE and the broker after a streamless raw spawn failure",
      async () => {
        const host = createSpawnBrokerHost();
        try {
          await host.ready();
          const pid = host.pid;
          if (pid === undefined) {
            throw new Error("Ready spawn broker has no process identifier");
          }
          await runValidCommand(host);
          const before = await openDescriptorCount(pid);
          const limitArgs = [
            "--pid",
            String(pid),
            "--nofile",
            "--output",
            "SOFT,HARD",
            "--noheadings",
            "--raw",
          ];
          const { stdout: limits } = await execFileAsync("prlimit", limitArgs);
          const [soft, hard] = limits.trim().split(/\s+/);
          if (soft === undefined || hard === undefined) {
            throw new Error("prlimit did not report both descriptor limits");
          }
          // Existing IPC remains usable; only this disposable broker loses new fd slots.
          expect(host.pid).toBe(pid);
          await execFileAsync("prlimit", ["--pid", String(pid), "--nofile=3:"]);
          const { stdout: pressured } = await execFileAsync("prlimit", limitArgs);
          expect(pressured.trim().split(/\s+/)).toEqual(["3", hard]);
          const child = host.spawn(process.execPath, ["-e", "process.exit(0)"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          const closed = child.waitForClose();
          await expect(child.ready()).rejects.toMatchObject({ code: "EMFILE" });
          await closed;
          expect(child.pid).toBeUndefined();
          expect(host.pid).toBe(pid);
          await execFileAsync("prlimit", ["--pid", String(pid), `--nofile=${soft}:`]);
          const { stdout: restored } = await execFileAsync("prlimit", limitArgs);
          expect(restored.trim()).toBe(limits.trim());
          await runValidCommand(host);
          expect(host.pid).toBe(pid);
          expect(await openDescriptorCount(pid)).toBe(before);
        } finally {
          // A failed assertion closes the broker instead of restoring a potentially retired PID.
          await host.close();
        }
      },
    );
  },
);
