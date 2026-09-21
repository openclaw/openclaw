import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import * as execSpawn from "./exec-spawn.js";
import { runCommandWithTimeout } from "./exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unbufferedExecSpawn: {
  spawnCommandWithInvocation: typeof execSpawn.spawnCommandWithInvocation<{ buffer: false }>;
} = execSpawn;

describe("child input admission", () => {
  it.skipIf(process.platform === "win32")(
    "withholds EOF from a rejected child until its process exits",
    async ({ signal }) => {
      const dir = tempDirs.make("openclaw-exec-input-admission-");
      const effect = path.join(dir, "effect");
      const argv = [
        process.execPath,
        "-e",
        [
          "const fs=require('node:fs')",
          "process.on('SIGTERM',()=>process.exit(0))",
          "fs.writeSync(1,'ready')",
          "fs.readFileSync(0,'utf8')",
          `fs.writeFileSync(${JSON.stringify(effect)},'unauthorized')`,
          "setInterval(()=>{},1000)",
        ].join(";"),
      ];
      const spawnOptions = {
        buffer: false,
        detached: true,
        encoding: "buffer",
        reject: false,
        stdio: ["pipe", "pipe", "pipe"],
      } satisfies Parameters<typeof execSpawn.spawnCommandWithInvocation>[1];
      const spawned = execSpawn.spawnCommandWithInvocation<{ buffer: false }>(argv, spawnOptions);
      let restoreSpawn: (() => void) | undefined;
      try {
        // The real child must install its signal handler before admission rejects.
        // Its synchronous read prevents SIGTERM handling until input reaches EOF.
        expect(await once(spawned.child.stdout!, "data", { signal })).toEqual([
          Buffer.from("ready"),
        ]);
        const spawnSpy = vi
          .spyOn(unbufferedExecSpawn, "spawnCommandWithInvocation")
          .mockImplementationOnce((_argv, options) => {
            expect(options?.buffer).toBe(false);
            return spawned;
          });
        restoreSpawn = () => spawnSpy.mockRestore();
        const refusal = new Error("authority lost before input");
        const work = runCommandWithTimeout(argv, {
          input: "forbidden",
          timeoutMs: 5_000,
          killProcessTree: true,
          beforeInput: () => {
            throw refusal;
          },
        });
        await expect(work).rejects.toBe(refusal);
        expect(existsSync(effect)).toBe(false);
        expect(refusal).toMatchObject({ cleanup: "forced" });
        expect(isPidAlive(spawned.child.pid!)).toBe(false);
      } finally {
        restoreSpawn?.();
        if (
          spawned.child.nodeChildProcess.exitCode === null &&
          spawned.child.nodeChildProcess.signalCode === null
        ) {
          spawned.child.kill("SIGKILL");
        }
        await spawned.child;
      }
    },
  );
});
