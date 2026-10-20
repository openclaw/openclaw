// Covers TUI launch argument and environment construction.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const detachMock = vi.hoisted(() => vi.fn());
let pauseSpy: MockInstance;
let resumeSpy: MockInstance;

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: vi.fn(() => ({ detach: detachMock })),
}));

import { launchTuiCli } from "./tui-launch.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];

function createChildProcess(pid?: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid }) as ChildProcess;
}

function expectSpawned(expectedArgs: string[]) {
  expect(spawnMock).toHaveBeenCalledOnce();
  const call = spawnMock.mock.calls[0] as [string, string[], SpawnOptions] | undefined;
  if (!call) {
    throw new Error("missing spawn call");
  }
  const [command, args, options] = call;
  expect(command).toBe(process.execPath);
  expect(args).toEqual(expectedArgs);
  expect(options.stdio).toBe("inherit");
  expect(options.env).toBe(process.env);
}

describe("launchTuiCli", () => {
  beforeEach(() => {
    process.argv = [...originalArgv];
    process.argv[1] = "/repo/openclaw.mjs";
    process.execArgv.length = 0;
    spawnMock.mockReset();
    const child = createChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    detachMock.mockReset();
    pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.execArgv.length = 0;
    process.execArgv.push(...originalExecArgv);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters inherited inspector flags when relaunching TUI", async () => {
    process.execArgv.push(
      "--import",
      "tsx",
      "--inspect",
      "127.0.0.1:9231",
      "--inspect=127.0.0.1:9229",
      "--inspect-brk",
      "--inspect-wait=0",
      "--inspect-port",
      "9230",
      "--no-warnings",
    );
    await launchTuiCli({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      password: "test-password",
      deliver: false,
    });

    expectSpawned([
      "--import",
      "tsx",
      "--no-warnings",
      "/repo/openclaw.mjs",
      "tui",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "test-token",
      "--password",
      "test-password",
    ]);
  });

  it("passes initial message and timeout through to the relaunched TUI", async () => {
    await launchTuiCli({
      local: true,
      deliver: false,
      message: "Wake up, my friend!",
      timeoutMs: 300_000,
    });

    expectSpawned([
      "/repo/openclaw.mjs",
      "tui",
      "--local",
      "--message",
      "Wake up, my friend!",
      "--timeout-ms",
      "300000",
    ]);
  });

  it("keeps parent stdin paused after the relaunched TUI exits", async () => {
    await launchTuiCli({ deliver: false });

    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it.each(["/standalone/runtime/openclaw.mjs", undefined])(
    "launches standalone TUI with entry %s",
    async (entry) => {
      vi.stubGlobal("__openclawStandaloneRootUrl", "file:///standalone/runtime/");
      process.argv = entry ? [process.execPath, entry] : [process.execPath];
      process.execArgv.push("--trace-warnings");
      await launchTuiCli({ deliver: false });
      expectSpawned(["tui"]);
    },
  );

  it("still rejects an unavailable loose CLI entry", async () => {
    process.argv = [process.execPath];

    await expect(launchTuiCli({ deliver: false })).rejects.toThrow(
      "unable to relaunch TUI: current CLI entry path is unavailable",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects a spawn error when the child has no pid", async () => {
    const child = createChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(launchTuiCli({ deliver: false })).rejects.toThrow(
      "failed to launch TUI: spawn failed",
    );
    expect(detachMock).toHaveBeenCalledOnce();
  });

  it("waits for terminal exit across repeated operational errors", async () => {
    const child = createChildProcess(4242);
    spawnMock.mockReturnValue(child);
    let settled = false;

    const launched = launchTuiCli({ deliver: false }).finally(() => {
      settled = true;
    });
    child.emit("error", new Error("first signal delivery failed"));
    child.emit("error", new Error("second signal delivery failed"));
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(detachMock).not.toHaveBeenCalled();

    child.emit("exit", 0, null);
    await expect(launched).resolves.toBeUndefined();
    expect(detachMock).toHaveBeenCalledOnce();
  });
});
