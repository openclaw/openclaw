import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

function createChild(pid = 42) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  spawnMock.mockReturnValue(child);
  return child;
}

describe("Docker scheduler Windows child shutdown", () => {
  it.each(["observed exit", "still live", "signal failure"] as const)(
    "requires observed Windows child completion after SIGINT: %s",
    async (completion) => {
      vi.resetModules();
      const handlers = new Map<string, () => void>();
      const originalOn = process.on.bind(process);
      const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          handlers.set(event, listener as () => void);
          return process;
        }
        return originalOn(event, listener);
      });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const previousExitCode = process.exitCode;
      const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
      let child: ChildProcess | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const scheduler = await import("../../scripts/test-docker-all.mts");
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        process.exitCode = undefined;
        vi.useFakeTimers();
        spawnMock.mockReset();
        spawnSyncMock.mockReset();
        child = createChild();
        const childKill = vi.spyOn(child, "kill");
        Object.defineProperty(child, "exitCode", { value: null, configurable: true });
        Object.defineProperty(child, "signalCode", { value: null, configurable: true });
        if (completion === "signal failure") {
          childKill.mockImplementation(() => {
            throw new Error("fixture kill failed");
          });
        }
        pending = scheduler
          .runShellCommand({
            command: "fixture",
            env: {},
            label: "windows",
            timeoutKillGraceMs: 20,
          })
          .catch((error: unknown) => error);
        handlers.get("SIGINT")!();
        expect(childKill).toHaveBeenCalledWith("SIGINT");
        await vi.advanceTimersByTimeAsync(5);
        expect(process.exitCode).not.toBe(130);
        if (completion === "observed exit") {
          Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
          await vi.advanceTimersByTimeAsync(100);
          expect(await pending).toMatchObject({ status: 0, signal: null });
          expect(process.exitCode).toBe(130);
        } else {
          await vi.advanceTimersByTimeAsync(1_200);
          expect(process.exitCode).toBe(2);
          Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
          expect(await pending).toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: completion === "still live" ? "live" : "indeterminate",
          });
        }
        expect(spawnMock).toHaveBeenCalledWith(
          "bash",
          ["-c", "fixture"],
          expect.objectContaining({ detached: false }),
        );
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        if (child) {
          Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
          child.emit("close", 0, null);
        }
        if (pending) {
          await vi.advanceTimersByTimeAsync(1_200);
          await pending;
        }
        vi.useRealTimers();
        Object.defineProperty(process, "platform", platform);
        process.exitCode = previousExitCode;
        onSpy.mockRestore();
        diagnostic.mockRestore();
        spawnMock.mockReset();
        spawnSyncMock.mockReset();
      }
    },
  );
});
