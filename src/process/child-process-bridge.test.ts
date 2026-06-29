// Child process bridge tests cover signal forwarding and parent-death guard behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachChildProcessBridge,
  installChildProcessParentDeathGuard,
  OPENCLAW_RESPAWN_PARENT_PID,
  withChildProcessParentGuardEnv,
} from "./child-process-bridge.js";

describe("attachChildProcessBridge", () => {
  function createFakeChild() {
    const emitter = new EventEmitter() as EventEmitter & import("node:child_process").ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    emitter.kill = kill as import("node:child_process").ChildProcess["kill"];
    return { child: emitter, kill };
  }

  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const { child, kill } = createFakeChild();
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });

    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);

    detach();
  });
});

describe("withChildProcessParentGuardEnv", () => {
  it("adds the wrapper PID marker on Unix", () => {
    expect(
      withChildProcessParentGuardEnv({
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        parentPid: 12345,
        platform: "linux",
      }),
    ).toEqual({
      OPENCLAW_NODE_OPTIONS_READY: "1",
      [OPENCLAW_RESPAWN_PARENT_PID]: "12345",
    });
  });

  it("returns the env unchanged on Windows", () => {
    expect(
      withChildProcessParentGuardEnv({
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        parentPid: 12345,
        platform: "win32",
      }),
    ).toEqual({ OPENCLAW_NODE_OPTIONS_READY: "1" });
  });
});

describe("installChildProcessParentDeathGuard", () => {
  it("returns null on Windows", () => {
    expect(
      installChildProcessParentDeathGuard({
        runtime: {
          env: { [OPENCLAW_RESPAWN_PARENT_PID]: "12345" },
          platform: "win32",
        },
      }),
    ).toBeNull();
  });

  it("returns null when the marker is missing or invalid", () => {
    expect(
      installChildProcessParentDeathGuard({
        runtime: {
          env: {},
          platform: "linux",
        },
      }),
    ).toBeNull();
    expect(
      installChildProcessParentDeathGuard({
        runtime: {
          env: { [OPENCLAW_RESPAWN_PARENT_PID]: "not-a-number" },
          platform: "linux",
        },
      }),
    ).toBeNull();
  });

  it("exits when the guarded child is reparented", () => {
    let ppid = 12345;
    let intervalCallback: (() => void) | undefined;
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearInterval = vi.fn();
    const exit = vi.fn();
    const env = { [OPENCLAW_RESPAWN_PARENT_PID]: "12345" };

    const guard = installChildProcessParentDeathGuard({
      intervalMs: 10,
      runtime: {
        env,
        exit: exit as unknown as (code?: number) => never,
        pid: 67890,
        platform: "linux",
        ppid: () => ppid,
        setInterval: vi.fn((callback: () => void) => {
          intervalCallback = callback;
          return timer;
        }) as unknown as typeof setInterval,
        clearInterval,
      },
    });

    expect(guard).not.toBeNull();
    expect(env).toEqual({});
    expect(exit).not.toHaveBeenCalled();

    ppid = 1;
    intervalCallback?.();

    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps the guard alive while the parent PID matches", () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const exit = vi.fn();

    const guard = installChildProcessParentDeathGuard({
      intervalMs: 10,
      runtime: {
        env: { [OPENCLAW_RESPAWN_PARENT_PID]: "12345" },
        exit: exit as unknown as (code?: number) => never,
        pid: 67890,
        platform: "linux",
        ppid: () => 12345,
        setInterval: vi.fn(() => timer) as unknown as typeof setInterval,
        clearInterval: vi.fn(),
      },
    });

    expect(guard).not.toBeNull();
    expect(exit).not.toHaveBeenCalled();
  });

  it("detaches the guard cleanly", () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearInterval = vi.fn();

    const guard = installChildProcessParentDeathGuard({
      runtime: {
        env: { [OPENCLAW_RESPAWN_PARENT_PID]: "12345" },
        exit: vi.fn() as unknown as (code?: number) => never,
        pid: 67890,
        platform: "linux",
        ppid: () => 12345,
        setInterval: vi.fn(() => timer) as unknown as typeof setInterval,
        clearInterval,
      },
    });

    guard?.detach();
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });
});
