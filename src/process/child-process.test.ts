import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execa, type ResultPromise } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChildProcessOutputRelease,
  releaseChildProcessOutputAfterExit,
} from "./child-process.js";

function startDrain(alreadyExited = false) {
  vi.useFakeTimers();
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: alreadyExited ? 0 : null,
    signalCode: null,
  }) as unknown as ChildProcess;
  const cleanup = releaseChildProcessOutputAfterExit(child);
  if (!alreadyExited) {
    child.emit("exit", 0);
  }
  return { stdout, stderr, cleanup };
}

describe.skipIf(process.platform === "win32")("releaseChildProcessOutputAfterExit", () => {
  let runningChild: ResultPromise | undefined;
  const spawn = (command: string, buffer = true) =>
    (runningChild = execa("/bin/sh", ["-c", command], {
      buffer,
      detached: true,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
      stripFinalNewline: false,
    }));

  afterEach(() => {
    if (runningChild?.pid) {
      try {
        process.kill(-runningChild.pid, "SIGKILL");
      } catch {}
    }
    runningChild = undefined;
    vi.useRealTimers();
  });

  it("ignores late output and exit after the drain owner is disposed", async () => {
    vi.useFakeTimers();
    const released = vi.fn();
    const drain = createChildProcessOutputRelease(released);
    drain.onExit();
    drain.dispose();
    drain.onData();
    drain.onExit();
    await vi.runAllTimersAsync();
    expect(released).not.toHaveBeenCalled();
  });

  it.each([0, 250, 1_250])("drains inherited pipes (stall=%ims)", async (stallMs) => {
    const child = spawn(
      stallMs
        ? 'printf "HEAD\\n"; printf "HEAD\\n" >&2; ( sleep 0.05; printf "TAIL\\n"; printf "TAIL\\n" >&2 ) &'
        : 'printf "DONE\\n"; ( sleep 30 ) &',
      stallMs !== 0,
    );
    const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);
    let output = "";
    if (stallMs) {
      // Both buffered pipe data and release timers must be ready when JS resumes.
      await new Promise<void>((resolve) => {
        child.nodeChildProcess.once("exit", () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
          resolve();
        });
      });
    } else {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
    const startedAt = Date.now();
    const result = await child.finally(releaseOutput);
    if (stallMs) {
      expect(result).toMatchObject({ exitCode: 0, stdout: "HEAD\nTAIL\n", stderr: "HEAD\nTAIL\n" });
    } else {
      expect(output).toContain("DONE");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    }
  });

  it.each([false, true])(
    "bounds continuously writing descendants when drain starts after exit=%s",
    async (alreadyExited) => {
      const { stdout, stderr, cleanup } = startDrain(alreadyExited);
      const writer = setInterval(() => stdout.write("TICK\n"), 30);

      try {
        await vi.advanceTimersByTimeAsync(999);
        expect(stdout.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(stdout.destroyed).toBe(false);
        stdout.write("AFTER DEADLINE\n");
        await vi.advanceTimersByTimeAsync(1);
        expect([stdout.destroyed, stderr.destroyed]).toEqual([true, true]);
      } finally {
        clearInterval(writer);
        cleanup();
      }
    },
  );

  it.each(["idle", "hard"])("cancels pending %s release when cleaned up", async (deadline) => {
    const { stdout, stderr, cleanup } = startDrain();
    const writer = deadline === "hard" ? setInterval(() => stdout.write("TICK\n"), 30) : undefined;

    await vi.advanceTimersByTimeAsync(deadline === "hard" ? 1_000 : 100);
    cleanup();
    clearInterval(writer);
    await vi.runAllTimersAsync();
    expect([stdout.destroyed, stderr.destroyed]).toEqual([false, false]);
  });
});
