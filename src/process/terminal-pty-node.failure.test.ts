import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
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
vi.mock("../infra/node-runtime-executable.js", () => ({
  resolveNodeRuntimeExecutable: () => process.execPath,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  spawnMock.mockReset();
});

it("joins failed terminal startup cleanup when procfs identity is unavailable", async () => {
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
    const settled = vi.fn();
    void starting.then(settled, settled);
    child.emit("error", new Error("worker failed before startup"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals.mock.calls).toEqual([[7777, "SIGKILL"]]);
    expect(settled).not.toHaveBeenCalled();
    child.emit("message", { type: "ready", pid: 8888 });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    child.emit("message", { type: "exit", exitCode: 1 });
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    child.stdout.end();
    await expect(starting).rejects.toThrow("worker failed before startup");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals.mock.calls).toEqual([[7777, "SIGKILL"]]);
  });
});

it.runIf(process.platform !== "win32")(
  "joins the real helper before releasing cancelled PTY startup",
  async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const helperExit = createDeferredCore();
    let helper: ChildProcess | undefined;
    let helperExited = false;
    spawnMock.mockImplementation((...args: Parameters<typeof actual.spawn>) => {
      helper = actual.spawn(...args);
      helper.once("exit", () => {
        helperExited = true;
        helperExit.resolve();
      });
      return helper;
    });
    try {
      await expect(
        spawnNodeTerminalPty(
          { file: "/bin/sh", args: [], cwd: os.tmpdir(), cols: 80, rows: 24 },
          () => {
            throw new Error("PTY policy revoked");
          },
        ),
      ).rejects.toThrow("PTY policy revoked");
      expect(helperExited).toBe(true);
      expect(helper?.stdout?.readableEnded || helper?.stdout?.destroyed).toBe(true);
      expect(helper?.connected).toBe(false);
    } finally {
      if (helper && !helperExited) {
        helper.kill("SIGKILL");
        await helperExit.promise;
      }
    }
  },
);

it("settles a real helper spawn failure without requiring an exit event", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const missingNode = path.join(tempDirs.make("openclaw-pty-missing-node-"), "missing-node");
  let helper: ChildProcess | undefined;
  spawnMock.mockImplementation(
    (_file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      helper = actual.spawn(missingNode, args, options);
      return helper;
    },
  );
  await expect(
    spawnNodeTerminalPty({ file: "/bin/sh", args: [], cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(helper?.pid).toBeUndefined();
  expect(helper?.stdout?.readableEnded || helper?.stdout?.destroyed).toBe(true);
});
