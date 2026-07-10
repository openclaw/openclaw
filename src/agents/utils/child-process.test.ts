import { type ChildProcess, spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseChildProcessListeners, waitForChildProcess } from "./child-process.js";

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

describe("releaseChildProcessListeners", () => {
  function fakeChild(
    io: { stdout?: EventEmitter; stderr?: EventEmitter; stdin?: EventEmitter } = {},
  ): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter } {
    return Object.assign(new EventEmitter(), {
      stdout: "stdout" in io ? io.stdout : new EventEmitter(),
      stderr: "stderr" in io ? io.stderr : new EventEmitter(),
      stdin: "stdin" in io ? io.stdin : new EventEmitter(),
    }) as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter;
    };
  }

  it("removes all listeners from the child process", () => {
    const child = fakeChild();
    child.on("error", () => {});
    child.on("close", () => {});
    expect(child.listenerCount("error")).toBe(1);
    expect(child.listenerCount("close")).toBe(1);

    releaseChildProcessListeners(child as unknown as ChildProcess);

    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("removes data listeners from stdout, stderr, and stdin while keeping error listeners", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdout.on("data", () => {});
    stdout.on("error", () => {});
    stderr.on("data", () => {});
    stderr.on("error", () => {});
    stdin.on("data", () => {});
    stdin.on("error", () => {});

    const child = fakeChild({ stdout, stderr, stdin });

    releaseChildProcessListeners(child as unknown as ChildProcess);

    // Data listeners removed — the heavy ones holding buffer references
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("data")).toBe(0);
    // Error listeners preserved — Node throws unhandled "error" events
    expect(stdout.listenerCount("error")).toBe(1);
    expect(stderr.listenerCount("error")).toBe(1);
    expect(stdin.listenerCount("error")).toBe(1);
  });

  it("does not throw when stdout, stderr, or stdin are null", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
      stdin: null,
    }) as unknown as ChildProcess;

    expect(() => releaseChildProcessListeners(child)).not.toThrow();
  });

  it("clears accumulated data listeners so buffers can be GC'd", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = fakeChild({ stdout, stderr });
    const chunks: Buffer[] = [];
    child.on("close", () => {});
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    // Fire some data to prove the listener works
    stdout.emit("data", Buffer.from("hello"));
    expect(chunks).toHaveLength(1);

    releaseChildProcessListeners(child as unknown as ChildProcess);

    // After release, more data events won't fire — listener is gone
    stdout.emit("data", Buffer.from("world"));
    expect(chunks).toHaveLength(1);
    expect(child.listenerCount("close")).toBe(0);
  });
});
