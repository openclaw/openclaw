import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { destroyChildStreams, spawnWithFallback } from "./spawn-utils.js";

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  child.pid = 1234;
  child.killed = false;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

describe("spawnWithFallback", () => {
  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackLabel).toBe("safe-stdin");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnMock.mock.calls[1]?.[2]?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not retry on non-EBADF errors", async () => {
    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
  it("destroys stdio streams when spawn emits an error asynchronously", async () => {
    const stdinDestroy = vi.fn();
    const stdoutDestroy = vi.fn();
    const stderrDestroy = vi.fn();

    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const child = new EventEmitter() as ChildProcess;
        child.stdin = Object.assign(new PassThrough(), {
          destroy: stdinDestroy,
        }) as ChildProcess["stdin"];
        child.stdout = Object.assign(new PassThrough(), {
          destroy: stdoutDestroy,
        }) as ChildProcess["stdout"];
        child.stderr = Object.assign(new PassThrough(), {
          destroy: stderrDestroy,
        }) as ChildProcess["stderr"];
        child.pid = undefined as unknown as number;
        child.killed = false;
        child.kill = vi.fn(() => true) as ChildProcess["kill"];
        // Emit error asynchronously to simulate a failed spawn
        queueMicrotask(() => {
          const err = new Error("spawn EBADF");
          (err as NodeJS.ErrnoException).code = "EBADF";
          child.emit("error", err);
        });
        return child;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ label: "no-detach", options: { detached: false } }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    // Verify that the failed child's streams were destroyed
    expect(stdinDestroy).toHaveBeenCalled();
    expect(stdoutDestroy).toHaveBeenCalled();
    expect(stderrDestroy).toHaveBeenCalled();
  });

  it("destroys stdio streams when spawn fails without fallback", async () => {
    const stdinDestroy = vi.fn();
    const stdoutDestroy = vi.fn();
    const stderrDestroy = vi.fn();

    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = Object.assign(new PassThrough(), {
        destroy: stdinDestroy,
      }) as ChildProcess["stdin"];
      child.stdout = Object.assign(new PassThrough(), {
        destroy: stdoutDestroy,
      }) as ChildProcess["stdout"];
      child.stderr = Object.assign(new PassThrough(), {
        destroy: stderrDestroy,
      }) as ChildProcess["stderr"];
      child.pid = undefined as unknown as number;
      child.killed = false;
      child.kill = vi.fn(() => true) as ChildProcess["kill"];
      queueMicrotask(() => {
        const err = new Error("spawn ENOENT");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        child.emit("error", err);
      });
      return child;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);

    // Streams should be destroyed even without fallback
    expect(stdinDestroy).toHaveBeenCalled();
    expect(stdoutDestroy).toHaveBeenCalled();
    expect(stderrDestroy).toHaveBeenCalled();
  });
});

describe("destroyChildStreams", () => {
  it("destroys all stdio streams on a child process", () => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough() as ChildProcess["stdin"];
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    child.pid = 1234;
    child.killed = false;
    child.kill = vi.fn(() => true) as ChildProcess["kill"];

    expect(child.stdin!.destroyed).toBe(false);
    expect(child.stdout!.destroyed).toBe(false);
    expect(child.stderr!.destroyed).toBe(false);

    destroyChildStreams(child);

    expect(child.stdin!.destroyed).toBe(true);
    expect(child.stdout!.destroyed).toBe(true);
    expect(child.stderr!.destroyed).toBe(true);
  });

  it("handles missing streams gracefully", () => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = null as ChildProcess["stdin"];
    child.stdout = null as ChildProcess["stdout"];
    child.stderr = null as ChildProcess["stderr"];
    child.pid = 1234;
    child.killed = false;
    child.kill = vi.fn(() => true) as ChildProcess["kill"];

    // Should not throw
    expect(() => destroyChildStreams(child)).not.toThrow();
  });

  it("skips already-destroyed streams", () => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough() as ChildProcess["stdin"];
    stdin!.destroy();
    child.stdin = stdin;
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    child.pid = 1234;
    child.killed = false;
    child.kill = vi.fn(() => true) as ChildProcess["kill"];

    const destroySpy = vi.spyOn(stdin!, "destroy");

    destroyChildStreams(child);

    // stdin was already destroyed, should not be called again
    expect(destroySpy).not.toHaveBeenCalled();
    // stdout and stderr should be destroyed
    expect(child.stdout!.destroyed).toBe(true);
    expect(child.stderr!.destroyed).toBe(true);
  });
});
