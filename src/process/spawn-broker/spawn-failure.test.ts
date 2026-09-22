import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSpawnBrokerHost } from "./host.js";

const execFileAsync = promisify(execFile);

async function openDescriptorCount(pid: number): Promise<number> {
  if (process.platform === "linux") {
    return (await readdir(`/proc/${pid}/fd`)).length;
  }
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-Ff"]);
  return stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length;
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
          const runValidCommand = async () => {
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
          };
          await runValidCommand();
          const before = await openDescriptorCount(host.pid!);
          for (let attempt = 0; attempt < 24; attempt += 1) {
            const invalidCwd = attempt % 2 === 1;
            const child = host.spawn(invalidCwd ? process.execPath : missing, [], {
              ...(invalidCwd ? { cwd: missing } : {}),
              stdio: ["ignore", "pipe", "pipe"],
            });
            const closed = new Promise<void>((resolve) => {
              child.once("close", () => resolve());
            });
            await expect(child.ready()).rejects.toMatchObject({ code: "ENOENT" });
            await closed;
          }
          await runValidCommand();
          expect(await openDescriptorCount(host.pid!)).toBe(before);
        } finally {
          await host.close();
        }
      },
    );
  },
);
