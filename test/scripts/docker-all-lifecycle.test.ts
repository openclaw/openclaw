import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

function closeChild(child: ChildProcess) {
  Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
}

const handlers = new Map<string, () => void>();
const childKill = vi.fn<ChildProcess["kill"]>(() => true);
let restore: () => void;
let scheduler: typeof import("../../scripts/test-docker-all.mts");
let child: ChildProcess;
let pending: Promise<unknown> | undefined;
let diagnostic: MockInstance<typeof console.error>;

beforeEach(async () => {
  vi.resetModules();
  pending = undefined;
  handlers.clear();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM" || event === "SIGHUP") {
      handlers.set(event, listener as () => void);
      return process;
    }
    return originalOn(event, listener);
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousExitCode = process.exitCode;
  diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  restore = () => {
    Object.defineProperty(process, "platform", platform);
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  };
  scheduler = await import("../../scripts/test-docker-all.mts");
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  process.exitCode = undefined;
  spawnSyncMock.mockReset();
  child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: 42 });
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  childKill.mockReset().mockReturnValue(true);
  child.kill = childKill;
  spawnMock.mockReset().mockReturnValue(child);
  for (const key of ["exitCode", "signalCode"]) {
    Object.defineProperty(child, key, { value: null, configurable: true });
  }
});

afterEach(async () => {
  if (child) {
    Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
    child.emit("close", 0, null);
  }
  const fakeTimers = vi.isFakeTimers();
  if (fakeTimers) {
    await vi.advanceTimersByTimeAsync(1_200);
  }
  await pending;
  if (fakeTimers) {
    vi.useRealTimers();
  }
  restore();
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
});

function start(logFile?: string) {
  pending = scheduler
    .runShellCommand({
      command: "fixture",
      env: {},
      label: logFile ? "log-failure" : "windows",
      timeoutKillGraceMs: 20,
      ...(logFile && { logFile }),
    })
    .catch((error: unknown) => error);
  return pending;
}

describe("Docker scheduler Windows child shutdown", () => {
  it("acknowledges SIGHUP only after observed child completion", async () => {
    vi.useFakeTimers();
    const result = start();
    handlers.get("SIGHUP")!();
    expect(childKill).toHaveBeenCalledWith("SIGHUP");
    await vi.advanceTimersByTimeAsync(5);
    expect(process.exitCode).not.toBe(129);
    closeChild(child);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ status: 0, signal: null });
    expect(process.exitCode).toBe(129);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each(["observed exit", "still live", "signal failure", "signal after failure"] as const)(
    "requires observed Windows child completion after SIGINT: %s",
    async (completion) => {
      vi.useFakeTimers();
      if (completion === "signal failure") {
        childKill.mockImplementation(() => {
          throw new Error("fixture kill failed");
        });
      }
      const result = start();
      if (completion === "signal after failure") {
        child.emit("close", 0, null);
      } else {
        handlers.get("SIGINT")!();
        expect(childKill).toHaveBeenCalledWith("SIGINT");
      }
      await vi.advanceTimersByTimeAsync(5);
      expect(process.exitCode).not.toBe(130);
      if (completion === "observed exit") {
        closeChild(child);
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({ status: 0, signal: null });
        expect(process.exitCode).toBe(130);
        expect(diagnostic).not.toHaveBeenCalled();
      } else {
        await vi.advanceTimersByTimeAsync(1_200);
        if (completion === "signal after failure") {
          expect(process.exitCode).toBeUndefined();
          expect(diagnostic).not.toHaveBeenCalled();
          handlers.get("SIGINT")!();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(process.exitCode).toBe(2);
        closeChild(child);
        const failure = await result;
        expect(failure).toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: completion === "signal failure" ? "indeterminate" : "live",
        });
        const signalCount = childKill.mock.calls.length;
        handlers.get("SIGTERM")!();
        await vi.advanceTimersByTimeAsync(0);
        expect(childKill.mock.calls.slice(signalCount)).toEqual([["SIGKILL"]]);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        const [reported] = diagnostic.mock.calls[0]!;
        expect(reported).toBeInstanceOf(AggregateError);
        expect(reported.errors).toContain(failure);
      }
      expect(spawnMock).toHaveBeenCalledWith(
        "bash",
        ["-c", "fixture"],
        expect.objectContaining({ detached: false }),
      );
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("leaves caught imported log failures to the caller's process disposition", async () => {
    const createStream = vi.spyOn(fs, "createWriteStream");
    try {
      process.exitCode = 17;
      const result = start(os.tmpdir());
      const stream = createStream.mock.results.at(-1)!.value as fs.WriteStream;
      const failure = await new Promise<Error>((resolve) => {
        stream.once("error", resolve);
      });
      closeChild(child);
      expect(await result).toBe(failure);
      expect(stream.closed).toBe(true);
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
      expect(process.exitCode).toBe(17);
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      createStream.mockRestore();
    }
  });
});
