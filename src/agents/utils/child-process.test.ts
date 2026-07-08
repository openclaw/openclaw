import { type ChildProcess, spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "./child-process.js";

describe.skipIf(process.platform === "win32")("waitForChildProcess", () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  afterEach(() => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    child = undefined;
  });

  it("drains active descendant output after the parent exits", async () => {
    const command =
      'printf "HEAD\\n"; ( for i in 1 2 3 4 5 6; do sleep 0.05; printf "TICK$i\\n"; done ) &';
    child = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await expect(waitForChildProcess(child)).resolves.toBe(0);
    expect(output).toContain("HEAD");
    expect(output).toContain("TICK6");
  });

  it("releases a quiet inherited pipe after the idle grace", async () => {
    child = spawn("/bin/sh", ["-c", 'printf "DONE\\n"; ( sleep 30 ) &'], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const startedAt = Date.now();
    await expect(waitForChildProcess(child)).resolves.toBe(0);
    expect(output).toContain("DONE");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds draining from a continuously writing descendant", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
      }) as unknown as ChildProcess;
      let output = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      const completion = waitForChildProcess(fakeChild);
      fakeChild.emit("exit", 0);
      const writer = setInterval(() => stdout.write("TICK\n"), 30);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(completion).resolves.toBe(0);
      clearInterval(writer);
      expect(output).toContain("TICK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows stdout and stderr stream errors without rejecting", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ChildProcess;

    const completion = waitForChildProcess(fakeChild);
    stdout.emit("error", new Error("stdout read failed"));
    stderr.emit("error", new Error("stderr read failed"));
    fakeChild.emit("exit", 0);

    await expect(completion).resolves.toBe(0);
  });
});
