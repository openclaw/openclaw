import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { spawnNodeTerminalPty } from "./terminal-pty-node.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      if (String(args[0]).startsWith("/proc/")) {
        throw new Error("procfs unavailable");
      }
      return original.readFileSync(...args);
    },
  };
});
vi.mock("../infra/executable-path.js", () => ({ resolveExecutablePath: () => process.execPath }));
vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/terminal-worker.js"),
  resolveRuntimeWorkerArgv: () => [],
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("force-stops a failed terminal worker when procfs identity is unavailable", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 7777,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    disconnect: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
  });
  child.disconnect.mockImplementation(() => {
    child.connected = false;
    child.emit("disconnect");
  });
  spawnMock.mockReturnValue(child);
  const signals = vi.spyOn(process, "kill").mockReturnValue(true);
  await withMockedPlatform("linux", async () => {
    const starting = spawnNodeTerminalPty({
      file: "/bin/sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24,
    });
    child.emit("error", new Error("worker failed before startup"));
    await expect(starting).rejects.toThrow("worker failed before startup");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals.mock.calls).toEqual([[7777, "SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals.mock.calls).toEqual([[7777, "SIGKILL"]]);
  });
});
