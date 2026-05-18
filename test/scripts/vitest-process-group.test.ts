import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupVitestProcessGroupAfterExit,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  isVitestProcessGroupAlive,
  resolveVitestProcessGroupSignalTarget,
  shouldUseDetachedVitestProcessGroup,
} from "../../scripts/vitest-process-group.mjs";

describe("vitest process group helpers", () => {
  function getListenerSet(listeners: Map<string, Set<() => void>>, event: string) {
    const set = listeners.get(event);
    if (!set) {
      throw new Error(`expected ${event} listener set`);
    }
    return set;
  }

  function expectListenerCount(
    listeners: Map<string, Set<() => void>>,
    event: string,
    count: number,
  ) {
    expect(getListenerSet(listeners, event).size).toBe(count);
  }

  it("uses detached process groups on non-Windows hosts", () => {
    expect(shouldUseDetachedVitestProcessGroup("darwin")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("linux")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("win32")).toBe(false);
  });

  it("targets the process group on Unix and the direct pid on Windows", () => {
    expect(resolveVitestProcessGroupSignalTarget({ childPid: 4200, platform: "darwin" })).toBe(
      -4200,
    );
    expect(resolveVitestProcessGroupSignalTarget({ childPid: 4200, platform: "win32" })).toBe(4200);
    expect(resolveVitestProcessGroupSignalTarget({ childPid: undefined, platform: "darwin" })).toBe(
      null,
    );
  });

  it("forwards signals to the computed target and ignores cleanup races", () => {
    const kill = vi.fn();
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4200, "SIGTERM");

    kill.mockImplementationOnce(() => {
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(false);

    kill.mockImplementationOnce(() => {
      const error = new Error("permission race") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(false);
  });

  it("detects and cleans stale descendants scoped to the gate process group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    unrelated.unref();

    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
child.unref();
setTimeout(() => process.exit(0), 50);`,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );

    try {
      const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(code).toBe(0);
      expect(isVitestProcessGroupAlive({ childPid: child.pid, platform: process.platform })).toBe(
        true,
      );

      const log = vi.fn();
      const cleanup = await cleanupVitestProcessGroupAfterExit({
        childPid: child.pid,
        platform: process.platform,
        graceMs: 1000,
        forceGraceMs: 1000,
        intervalMs: 25,
        log,
      });

      expect(cleanup.staleProcessDetected).toBe(true);
      expect(cleanup.clean).toBe(true);
      expect(cleanup.signalsSent).toContain("SIGTERM");
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("stale process group detected after gate exit"),
      );
      expect(
        isVitestProcessGroupAlive({ childPid: unrelated.pid, platform: process.platform }),
      ).toBe(true);
    } finally {
      if (typeof unrelated.pid === "number") {
        try {
          process.kill(-unrelated.pid, "SIGKILL");
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  });

  it("installs and removes process cleanup listeners", () => {
    const listeners = new Map<string, Set<() => void>>();
    const fakeProcess = {
      on(event: string, handler: () => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off(event: string, handler: () => void) {
        listeners.get(event)?.delete(handler);
      },
    };
    const kill = vi.fn();
    const teardown = installVitestProcessGroupCleanup({
      child: { pid: 4200 },
      processObject: fakeProcess as unknown as NodeJS.Process,
      platform: "darwin",
      kill,
    });

    expectListenerCount(listeners, "SIGINT", 1);
    expectListenerCount(listeners, "SIGTERM", 1);
    expectListenerCount(listeners, "exit", 1);

    getListenerSet(listeners, "SIGTERM").values().next().value();
    expect(kill).toHaveBeenCalledWith(-4200, "SIGTERM");

    teardown();
    expectListenerCount(listeners, "SIGINT", 0);
    expectListenerCount(listeners, "SIGTERM", 0);
    expectListenerCount(listeners, "exit", 0);
  });

  it("raises process listener limits for highly parallel cleanup handlers", () => {
    const listeners = new Map<string, Set<() => void>>();
    let maxListeners = 10;
    const fakeProcess = {
      getMaxListeners: () => maxListeners,
      setMaxListeners: vi.fn((value: number) => {
        maxListeners = value;
        return fakeProcess;
      }),
      listenerCount(event: string) {
        return listeners.get(event)?.size ?? 0;
      },
      on(event: string, handler: () => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off(event: string, handler: () => void) {
        listeners.get(event)?.delete(handler);
      },
    };

    const teardowns = Array.from({ length: 12 }, (_, index) =>
      installVitestProcessGroupCleanup({
        child: { pid: 4200 + index },
        processObject: fakeProcess as unknown as NodeJS.Process,
        platform: "darwin",
        kill: vi.fn(),
      }),
    );

    expect(maxListeners).toBeGreaterThan(10);
    expect(fakeProcess.setMaxListeners).toHaveBeenCalled();

    for (const teardown of teardowns) {
      teardown();
    }
    expectListenerCount(listeners, "SIGINT", 0);
    expectListenerCount(listeners, "SIGTERM", 0);
    expectListenerCount(listeners, "exit", 0);
  });
});
