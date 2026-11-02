import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { isProcessAlive } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("starts owned-tree cleanup at leader exit while a descendant holds both output pipes", async () => {
  const root = dirs.make("managed-exit-output-");
  const owner = createVitestResourceOwner(root);
  const pidFile = path.join(root, "descendant.pid");
  const exited = createDeferred();
  const rescue = new AbortController();
  let child: ChildProcess | undefined;
  let pipesOpenAtExit = false;
  let stdout = "";
  let stderr = "";
  let guard: ReturnType<typeof setTimeout> | undefined;
  const command = runManagedCommand({
    bin: process.execPath,
    args: [
      "-e",
      `
const {spawn} = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(process.execPath, ["-e", 'process.send("ready"); process.disconnect(); setInterval(() => {}, 1000);'], {
  // Windows escapes libuv's parent-owned Job; POSIX retains the owned process group.
  detached: process.platform === "win32",
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
descendant.once("message", async () => {
  fs.writeFileSync(process.argv[1], String(descendant.pid));
  await Promise.all([
    new Promise(resolve => process.stdout.write("x".repeat(256 * 1024) + "stdout tail\\n", resolve)),
    new Promise(resolve => process.stderr.write("stderr tail\\n", resolve)),
  ]);
  process.exit(7);
});
`,
      pidFile,
    ],
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    requireProcessTreeExit: process.platform !== "win32",
    // No command timeout: this signal only rescues a failed regression in finally.
    signal: rescue.signal,
    onReady: (owned) => {
      child = owned;
      owned.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      owned.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      owned.once("exit", () => {
        pipesOpenAtExit = !owned.stdout?.closed && !owned.stderr?.closed;
        exited.resolve();
      });
    },
  }).catch((error: unknown) => error);
  try {
    await exited.promise;
    expect(pipesOpenAtExit).toBe(true);
    const outcome = await Promise.race([
      command,
      new Promise<never>((_, reject) => {
        // The owner has a 5-second cleanup allowance; this only detects a missing cleanup.
        guard = setTimeout(
          () => reject(new Error("owned cleanup did not settle after leader exit")),
          7_000,
        );
      }),
    ]);
    if (process.platform === "win32") {
      expect(outcome).toBe(7);
    } else {
      // Strict POSIX still reports an unexpected surviving group after extinguishing it.
      expect(outcome).toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "terminated",
      });
    }
    expect(child?.exitCode).toBe(7);
    expect(stdout).toBe("x".repeat(256 * 1024) + "stdout tail\n");
    expect(stderr).toBe("stderr tail\n");
    expect(child?.stdout?.closed).toBe(true);
    expect(child?.stderr?.closed).toBe(true);
    expect(isProcessAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
    owner.assertReleased();
  } finally {
    clearTimeout(guard);
    rescue.abort();
    await command;
  }
});
