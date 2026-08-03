// Child adapter E2E tests cover real attached Unix process-tree cleanup.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildAdapter } from "./child.js";

const fixtureDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirs.splice(0).map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

describe("createChildAdapter attached Unix termination", () => {
  it.runIf(process.platform === "linux")(
    "force-kills a TERM-resistant descendant after its root exits",
    { timeout: 10_000 },
    async () => {
      const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-child-tree-"));
      fixtureDirs.push(fixtureDir);
      const descendantPidPath = path.join(fixtureDir, "descendant.pid");
      let descendantPid: number | undefined;
      let adapter: Awaited<ReturnType<typeof createChildAdapter>> | undefined;
      const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
      process.env.OPENCLAW_SERVICE_MARKER = "test";

      try {
        const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
        const rootSource = [
          "const { spawn } = require('node:child_process')",
          "const fs = require('node:fs')",
          `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' })`,
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))`,
          "process.on('SIGTERM', () => process.exit(0))",
          "setInterval(() => {}, 1000)",
        ].join(";");
        adapter = await createChildAdapter({
          argv: [process.execPath, "-e", rootSource],
          stdinMode: "pipe-closed",
        });

        descendantPid = await waitForPidFile(descendantPidPath);
        expect(isProcessAlive(descendantPid)).toBe(true);

        adapter.kill("SIGTERM");
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        await expect(waitForProcessExit(descendantPid, 6_500)).resolves.toBe(true);
      } finally {
        adapter?.kill("SIGKILL");
        adapter?.dispose();
        killIfAlive(descendantPid);
        restoreServiceMarker(previousMarker);
      }
    },
  );
});

async function waitForPidFile(pidPath: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The root has not written the child PID yet.
    }
    await delay(25);
  }
  throw new Error("timed out waiting for descendant PID");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

function killIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can exit between the liveness check and the force signal.
  }
}

function restoreServiceMarker(previousMarker: string | undefined): void {
  if (previousMarker === undefined) {
    delete process.env.OPENCLAW_SERVICE_MARKER;
    return;
  }
  process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
