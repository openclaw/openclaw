import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const killTreeMocks = vi.hoisted(() => ({ signalProcessTree: vi.fn() }));

vi.mock("../process/kill-tree.js", () => ({
  signalProcessTree: killTreeMocks.signalProcessTree,
}));

import { createTuiAuthChildOwner } from "./tui-auth-child.js";

function createChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(),
    pid,
    signalCode: null,
  }) as unknown as ChildProcess;
}

function emitExit(
  child: ChildProcess,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): void {
  Object.assign(child, { exitCode, signalCode: signal });
  child.emit("exit", exitCode, signal);
}

function startChild(pid: number) {
  const owner = createTuiAuthChildOwner();
  const child = createChild(pid);
  return { owner, child, result: owner.spawnAndWait(() => child) };
}
function expectSignals(...signals: Array<[number, NodeJS.Signals]>) {
  expect(killTreeMocks.signalProcessTree.mock.calls).toEqual(
    signals.map(([pid, signal]) => [pid, signal, { detached: false }]),
  );
}

describe("TUI auth child owner", () => {
  afterEach(() => {
    vi.useRealTimers();
    killTreeMocks.signalProcessTree.mockReset();
  });

  it("does not spawn after terminal close", async () => {
    const owner = createTuiAuthChildOwner();
    const spawnChild = vi.fn(() => createChild(101));
    await owner.close();

    await expect(owner.spawnAndWait(spawnChild)).rejects.toThrow("owner is closed");
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("waits for normal completion and releases the exact child", async () => {
    const { owner, child, result } = startChild(102);
    const secondSpawn = vi.fn(() => createChild(202));
    await expect(owner.spawnAndWait(secondSpawn)).rejects.toThrow("already running");
    expect(secondSpawn).not.toHaveBeenCalled();

    emitExit(child, 0, null);

    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(killTreeMocks.signalProcessTree).not.toHaveBeenCalled();

    const nextChild = createChild(203);
    const nextResult = owner.spawnAndWait(() => nextChild);
    emitExit(nextChild, 0, null);
    await expect(nextResult).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it("cancels gracefully, then force-kills only the still-active child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { owner, child, result } = startChild(103);

    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    const repeatedClose = owner.close();
    await Promise.resolve();
    expect(closed).toBe(false);

    expectSignals([103, "SIGTERM"]);
    vi.advanceTimersByTime(999);
    expectSignals([103, "SIGTERM"]);
    vi.advanceTimersByTime(1);
    expectSignals([103, "SIGTERM"], [103, "SIGKILL"]);

    emitExit(child, null, "SIGKILL");
    await expect(result).resolves.toEqual({ exitCode: null, signal: "SIGKILL" });
    await Promise.all([closing, repeatedClose]);
    expect(closed).toBe(true);
  });

  it("clears force escalation when the owned child exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { owner, child, result } = startChild(104);
    const closing = owner.close();
    emitExit(child, null, "SIGTERM");

    await expect(result).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    await closing;
    vi.advanceTimersByTime(1_001);
    expectSignals([104, "SIGTERM"]);
  });
});
