import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
const params = { file: "/bin/sh", args: [], cols: 80, rows: 24 };
let helper: ChildProcess | undefined;
const exited = new WeakSet<ChildProcess>();
let executable: string | undefined;

beforeEach(async () => {
  helper = executable = undefined;
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementation((file: string, args: string[], options: SpawnOptions) => {
    helper = actual.spawn(executable ?? file, args, options);
    helper.once("exit", exited.add.bind(exited, helper));
    return helper;
  });
});
afterEach(async () => {
  if (helper?.pid && !exited.has(helper)) {
    const exit = once(helper, "exit");
    helper.kill("SIGKILL");
    await exit;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("joins failed terminal startup cleanup when procfs identity is unavailable", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 7777,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    disconnect(): void {
      child.connected = false;
      child.emit("disconnect");
    },
  });
  spawnMock.mockReturnValue(child);
  const signals = vi.spyOn(process, "kill").mockReturnValue(true);
  await withMockedPlatform("linux", async () => {
    const starting = spawnNodeTerminalPty(params);
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

it.runIf(process.platform !== "win32")("joins the cancelled PTY helper", async () => {
  await expect(
    spawnNodeTerminalPty(params, () => {
      throw new Error("PTY policy revoked");
    }),
  ).rejects.toThrow("PTY policy revoked");
  expect(helper && exited.has(helper)).toBe(true);
  expect(helper?.stdout?.readableEnded || helper?.stdout?.destroyed).toBe(true);
  expect(helper?.connected).toBe(false);
});

it("settles a real helper spawn failure without requiring an exit event", async () => {
  executable = path.join(tempDirs.make("openclaw-pty-missing-node-"), "missing-node");
  await expect(spawnNodeTerminalPty(params)).rejects.toMatchObject({ code: "ENOENT" });
  expect(helper?.pid).toBeUndefined();
  expect(helper?.stdout?.readableEnded || helper?.stdout?.destroyed).toBe(true);
});
