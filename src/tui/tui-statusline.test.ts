/**
 * Lifecycle + child-process tests for createStatusLine.
 *
 * Uses an injected fake spawn so we can drive child lifecycle deterministically
 * (no real subprocesses, no flakiness). Validates:
 *   1. start() executes the command and forwards stdout to onOutput
 *   2. stop() clears the interval (no further executions)
 *   3. stop() while a child is running sends SIGTERM
 *   4. SIGTERM-ignoring child gets SIGKILL after the grace period
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusLine, type SpawnFn } from "./tui-statusline.js";

type FakeChild = ChildProcess & {
  __kill: ReturnType<typeof vi.fn>;
  __close: (code: number, stdout?: string) => void;
};

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  (emitter as unknown as { stdout: NodeJS.ReadableStream }).stdout = stdout;

  // Track signal sent + whether the runtime considers the child exited.
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperty(emitter, "exitCode", { get: () => exitCode });
  Object.defineProperty(emitter, "signalCode", { get: () => signalCode });

  const killSpy = vi.fn((sig?: NodeJS.Signals | number) => {
    // Default behavior: any signal kills the child immediately.
    if (sig === "SIGKILL") {
      signalCode = "SIGKILL";
      exitCode = null;
      queueMicrotask(() => emitter.emit("close", null));
    } else if (typeof sig === "string") {
      signalCode = sig;
      exitCode = null;
      queueMicrotask(() => emitter.emit("close", null));
    } else {
      signalCode = "SIGTERM";
      queueMicrotask(() => emitter.emit("close", null));
    }
    return true;
  });
  (emitter as unknown as { kill: typeof killSpy }).kill = killSpy;

  const fake = emitter as FakeChild;
  fake.__kill = killSpy;
  fake.__close = (code: number, stdoutText?: string) => {
    if (stdoutText !== undefined) {
      stdout.emit("data", Buffer.from(stdoutText, "utf8"));
    }
    exitCode = code;
    emitter.emit("close", code);
  };
  return fake;
}

function makeSpawnReturning(child: ChildProcess): SpawnFn {
  return vi.fn(() => child) as unknown as SpawnFn;
}

describe("createStatusLine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards child stdout to onOutput on successful execution", async () => {
    const child = makeFakeChild();
    const onOutput = vi.fn();
    const handle = createStatusLine({
      command: "echo hi",
      refreshInterval: 1000,
      timeout: 500,
      onOutput,
      spawnCommand: makeSpawnReturning(child),
    });

    handle.start();
    child.__close(0, "hello\n");
    await vi.advanceTimersByTimeAsync(0);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith("hello\n");
    handle.stop();
  });

  it("stop() prevents subsequent timer-driven executions", async () => {
    const spawnSpy = vi.fn(() => makeFakeChild()) as unknown as SpawnFn;
    const handle = createStatusLine({
      command: "echo hi",
      refreshInterval: 1000,
      timeout: 500,
      onOutput: () => {},
      spawnCommand: spawnSpy,
    });

    handle.start();
    expect(spawnSpy).toHaveBeenCalledTimes(1); // immediate execute()
    handle.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnSpy).toHaveBeenCalledTimes(1); // no further ticks
  });

  it("stop() sends SIGTERM to a currently-running child", () => {
    const child = makeFakeChild();
    const handle = createStatusLine({
      command: "sleep 5",
      refreshInterval: 1000,
      timeout: 500,
      onOutput: () => {},
      spawnCommand: makeSpawnReturning(child),
    });

    handle.start();
    expect(child.__kill).not.toHaveBeenCalled();

    handle.stop();
    expect(child.__kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // A child that traps SIGTERM: stays "alive" (exitCode/signalCode null) until SIGKILL.
    const trappingChild = new EventEmitter() as unknown as ChildProcess;
    const trappingStdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    (trappingChild as unknown as { stdout: NodeJS.ReadableStream }).stdout = trappingStdout;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    Object.defineProperty(trappingChild, "exitCode", { get: () => exitCode });
    Object.defineProperty(trappingChild, "signalCode", { get: () => signalCode });
    const killSpy = vi.fn((sig?: NodeJS.Signals | number) => {
      // SIGTERM: trapped — do nothing, child stays alive.
      // SIGKILL: cannot be trapped — emit close.
      if (sig === "SIGKILL") {
        signalCode = "SIGKILL";
        queueMicrotask(() => trappingChild.emit("close", null));
      }
      return true;
    });
    (trappingChild as unknown as { kill: typeof killSpy }).kill = killSpy;

    const handle = createStatusLine({
      command: "trap-sigterm.sh",
      refreshInterval: 1000,
      timeout: 500,
      onOutput: () => {},
      spawnCommand: makeSpawnReturning(trappingChild),
    });

    handle.start();
    handle.stop();

    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith("SIGKILL");

    // Advance past the SIGKILL grace period (200 ms in implementation).
    await vi.advanceTimersByTimeAsync(300);

    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
  });
});
