// Port tests cover CLI port probing and conflict handling.
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist the factory so vi.mock can access it.
const mockCreateServer = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return { ...actual, createServer: mockCreateServer };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: mockExecFileSync };
});

vi.mock("../infra/ports-lsof.js", () => ({
  resolveLsofCommandSync: vi.fn(() => "/usr/bin/lsof"),
}));

import { forceFreePort, waitForPortBindable } from "./ports.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Build a minimal fake net.Server that emits a given error code on listen(). */
function makeErrServer(code: string): net.Server {
  const err = Object.assign(new Error(`bind error: ${code}`), {
    code,
  }) as NodeJS.ErrnoException;

  const fake = new EventEmitter() as unknown as net.Server;
  (fake as unknown as { close: (cb?: () => void) => net.Server }).close = (cb?: () => void) => {
    cb?.();
    return fake;
  };
  (fake as unknown as { unref: () => net.Server }).unref = () => fake;
  (fake as unknown as { listen: (...args: unknown[]) => net.Server }).listen = (
    ..._args: unknown[]
  ) => {
    setImmediate(() => fake.emit("error", err));
    return fake;
  };
  return fake;
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

describe("waitForPortBindable", () => {
  it("probes the provided host when waiting for bindability", async () => {
    const listenCalls: Array<{ port: number; host: string }> = [];
    const fakeServer = new EventEmitter() as unknown as net.Server;
    (fakeServer as unknown as { close: (cb?: () => void) => net.Server }).close = (
      cb?: () => void,
    ) => {
      cb?.();
      return fakeServer;
    };
    (fakeServer as unknown as { unref: () => net.Server }).unref = () => fakeServer;
    (fakeServer as unknown as { listen: (...args: unknown[]) => net.Server }).listen = (
      ...args: unknown[]
    ) => {
      const [port, host] = args as [number, string];
      listenCalls.push({ port, host });
      const callback = args.find((a) => typeof a === "function") as (() => void) | undefined;
      setImmediate(() => callback?.());
      return fakeServer;
    };
    mockCreateServer.mockReturnValue(fakeServer);

    await expect(
      waitForPortBindable(9999, { timeoutMs: 100, intervalMs: 10, host: "127.0.0.1" }),
    ).resolves.toBe(0);
    expect(listenCalls[0]).toEqual({ port: 9999, host: "127.0.0.1" });
  });

  it("propagates EACCES rejection immediately without retrying", async () => {
    // Every call to createServer will emit EACCES — so if waitForPortBindable retried,
    // mockCreateServer would be called many times. We assert it's called exactly once.
    mockCreateServer.mockClear();
    mockCreateServer.mockReturnValue(makeErrServer("EACCES"));
    await expectRejectCode(waitForPortBindable(80, { timeoutMs: 5000, intervalMs: 50 }), "EACCES");
    // Only one probe should have been attempted — no spinning through the retry loop.
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
  });

  it.each(["EADDRNOTAVAIL", "EINVAL"])(
    "propagates non-retryable %s bind errors immediately",
    async (code) => {
      mockCreateServer.mockClear();
      mockCreateServer.mockReturnValue(makeErrServer(code));

      await expectRejectCode(
        waitForPortBindable(9999, { timeoutMs: 5000, intervalMs: 50, host: "192.0.2.1" }),
        code,
      );
      expect(mockCreateServer).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds oversized bindability intervals by the remaining timeout", async () => {
    mockCreateServer.mockReturnValue(makeErrServer("EADDRINUSE"));

    await expect(
      waitForPortBindable(9999, {
        timeoutMs: 1,
        intervalMs: Number.MAX_SAFE_INTEGER,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(/still not bindable after 1ms/);
  });
});

// ─── forceFreePort ──────────────────────────────────────────────────────────

/** Build fake lsof -FpFc output for the given PIDs. */
function lsofOutput(pids: number[]): string {
  return pids.map((p) => `p${p}\ncnode\n`).join("");
}

describe("forceFreePort", () => {
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
  };

  afterEach(() => {
    // Restore platform to the actual value so other tests are not affected.
    try {
      Object.defineProperty(process, "platform", {
        value: process.platform,
        configurable: true,
      });
    } catch {
      // Already restored or non-configurable; ignore.
    }
  });

  it("swallows ESRCH when a port listener exits before SIGTERM", () => {
    setPlatform("linux");
    mockExecFileSync.mockReturnValue(lsofOutput([500, 600]));
    const killSpy = vi.spyOn(process, "kill");
    const esrchErr = Object.assign(new Error("no such process"), { code: "ESRCH" });
    // First kill succeeds, second throws ESRCH.
    killSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw esrchErr;
      });

    const result = forceFreePort(9999);

    // Both PIDs reported as freed — ESRCH means the port is already free.
    expect(result).toEqual([
      { pid: 500, command: "node" },
      { pid: 600, command: "node" },
    ]);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(600, "SIGTERM");
    killSpy.mockRestore();
  });

  it("re-throws non-ESRCH kill errors", () => {
    setPlatform("linux");
    mockExecFileSync.mockReturnValue(lsofOutput([500]));
    const killSpy = vi.spyOn(process, "kill");
    const epermErr = Object.assign(new Error("permission denied"), { code: "EPERM" });
    killSpy.mockImplementation(() => {
      throw epermErr;
    });

    expect(() => forceFreePort(9999)).toThrow("failed to kill pid 500");
    killSpy.mockRestore();
  });

  it("continues past multiple ESRCH exits in the same call", () => {
    setPlatform("linux");
    mockExecFileSync.mockReturnValue(lsofOutput([100, 200, 300]));
    const killSpy = vi.spyOn(process, "kill");
    const esrchErr = Object.assign(new Error("no such process"), { code: "ESRCH" });
    killSpy
      .mockImplementationOnce(() => {
        throw esrchErr;
      })
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw esrchErr;
      });

    const result = forceFreePort(9999);

    expect(result).toEqual([
      { pid: 100, command: "node" },
      { pid: 200, command: "node" },
      { pid: 300, command: "node" },
    ]);
    expect(killSpy).toHaveBeenCalledTimes(3);
    killSpy.mockRestore();
  });
});
