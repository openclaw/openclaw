import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const killTreeMocks = vi.hoisted(() => ({ signalProcessTree: vi.fn() }));

vi.mock("../process/kill-tree.js", () => ({
  signalProcessTree: killTreeMocks.signalProcessTree,
}));

import { createTuiAuthChildOwner } from "./tui-auth-child.js";

function createChild(pid: number): ChildProcess {
  const state = { exitCode: null, kill: vi.fn(), pid, signalCode: null };
  return Object.assign(new EventEmitter(), state) as unknown as ChildProcess;
}

function startChild(pid: number, owner = createTuiAuthChildOwner()) {
  const child = createChild(pid);
  const result = owner.spawnAndWait(() => child);
  return {
    owner,
    finish: async (exitCode: number | null = 0, signal: NodeJS.Signals | null = null) => {
      Object.assign(child, { exitCode, signalCode: signal });
      child.emit("exit", exitCode, signal);
      await expect(result).resolves.toEqual({ exitCode, signal });
    },
  };
}
function expectSignals(...signals: Array<[number, NodeJS.Signals]>) {
  expect(killTreeMocks.signalProcessTree.mock.calls).toEqual(
    signals.map(([pid, signal]) => [pid, signal, { detached: false }]),
  );
}

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
  const { owner, finish } = startChild(102);
  const secondSpawn = vi.fn(() => createChild(202));
  await expect(owner.spawnAndWait(secondSpawn)).rejects.toThrow("already running");
  expect(secondSpawn).not.toHaveBeenCalled();
  await finish();
  expect(killTreeMocks.signalProcessTree).not.toHaveBeenCalled();
  await startChild(203, owner).finish();
});

it("cancels gracefully, then force-kills only the still-active child", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { owner, finish } = startChild(103);
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
  await finish(null, "SIGKILL");
  await Promise.all([closing, repeatedClose]);
  expect(closed).toBe(true);
});

it("clears force escalation when the owned child exits", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { owner, finish } = startChild(104);
  const closing = owner.close();
  await finish(null, "SIGTERM");
  await closing;
  vi.advanceTimersByTime(1_001);
  expectSignals([104, "SIGTERM"]);
});
