import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const detachMock = vi.hoisted(() => vi.fn());
let pauseSpy: MockInstance;
let resumeSpy: MockInstance;

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: vi.fn(() => ({ detach: detachMock })),
}));

import { launchTuiCli } from "./tui-launch.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const cli = ["/repo/openclaw.mjs", "tui"];

function createChildProcess(pid?: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid }) as ChildProcess;
}

function expectSpawned(expectedArgs: string[]) {
  expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
    process.execPath,
    expectedArgs,
    expect.objectContaining({ stdio: "inherit" }),
  );
  expect(spawnMock.mock.calls[0]?.[2].env).toBe(process.env);
}

function emitChild(event: "exit" | "error", ...args: unknown[]) {
  const child = createChildProcess();
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => child.emit(event, ...args));
    return child;
  });
}

describe("launchTuiCli", () => {
  beforeEach(() => {
    process.argv = [...originalArgv];
    process.argv[1] = "/repo/openclaw.mjs";
    process.execArgv.length = 0;
    spawnMock.mockReset();
    emitChild("exit", 0, null);
    detachMock.mockReset();
    pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters inherited inspector flags when relaunching TUI", async () => {
    const url = "ws://127.0.0.1:18789";
    const authArgs = ["--url", url, "--token", "test-token", "--password", "test-password"];
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
    await launchTuiCli({ url, token: "test-token", password: "test-password", deliver: false });

    expectSpawned(["--import", "tsx", "--no-warnings", ...cli, ...authArgs]);
  });

  it("passes initial message and timeout through to the relaunched TUI", async () => {
    const message = "Wake up, my friend!";
    await launchTuiCli({ local: true, deliver: false, message, timeoutMs: 300_000 });

    expectSpawned([...cli, "--local", "--message", message, "--timeout-ms", "300000"]);
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
    emitChild("error", new Error("spawn failed"));

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
