// src/infra/child-registry.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  registerChild,
  unregisterChild,
  killAllChildren,
  killAllChildrenSync,
  getRegisteredChildren,
  clearRegistry,
} from "./child-registry.js";

describe("child-registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    clearRegistry();
  });

  it("registers a child process with PID", () => {
    const mockProc = {
      pid: 12345,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("test-child", mockProc);

    const children = getRegisteredChildren();
    expect(children).toHaveLength(1);
    expect(children[0].pid).toBe(12345);
    expect(children[0].name).toBe("test-child");
  });

  it("does not register if no PID", () => {
    const mockProc = {
      pid: undefined,
      on: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("no-pid", mockProc);

    expect(getRegisteredChildren()).toHaveLength(0);
  });

  it("respects managedExternally flag", () => {
    const mockProc = {
      pid: 11111,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("managed", mockProc, { managedExternally: true });

    const children = getRegisteredChildren();
    expect(children[0].managedExternally).toBe(true);
  });

  it("unregisters a child by PID", () => {
    const mockProc = {
      pid: 22222,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("to-remove", mockProc);
    expect(getRegisteredChildren()).toHaveLength(1);

    unregisterChild(22222);
    expect(getRegisteredChildren()).toHaveLength(0);
  });

  it("killAllChildrenSync sends SIGKILL to all children", () => {
    const killFn = vi.fn();
    const mockProc = {
      pid: 33333,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: killFn,
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("to-kill", mockProc);
    killAllChildrenSync();

    expect(killFn).toHaveBeenCalledWith("SIGKILL");
  });

  it("skips already-dead processes", () => {
    const killFn = vi.fn();
    const mockProc = {
      pid: 44444,
      killed: false,
      exitCode: 0, // Already exited
      signalCode: null,
      kill: killFn,
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;

    registerChild("already-dead", mockProc);
    killAllChildrenSync();

    expect(killFn).not.toHaveBeenCalled();
  });
});

describe("child-registry integration", () => {
  it("kills a real spawned process", async () => {
    const proc = spawn("sleep", ["60"], { detached: false });
    registerChild("sleep-test", proc);

    expect(getRegisteredChildren()).toHaveLength(1);

    await killAllChildren("SIGTERM", { timeoutMs: 1000 });

    // Process should be killed
    expect(proc.killed || proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });
});
