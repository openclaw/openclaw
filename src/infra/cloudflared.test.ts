import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock spawn
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock runExec
const execMock = vi.fn();
vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => execMock(...args),
}));

// Mock existsSync
const existsSyncMock = vi.fn<(p: string) => boolean>(() => true);
vi.mock("node:fs", () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

describe("findCloudflaredBinary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY;
  });

  it("returns environment override when set", async () => {
    process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY = "/custom/cloudflared";
    const { findCloudflaredBinary } = await import("./cloudflared.js");
    const result = await findCloudflaredBinary(execMock);
    expect(result).toBe("/custom/cloudflared");
  });

  it("finds cloudflared via which", async () => {
    execMock.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "which") {
        return Promise.resolve({ stdout: "/usr/local/bin/cloudflared\n", stderr: "" });
      }
      // --version check
      return Promise.resolve({ stdout: "cloudflared version 2024.1.0\n", stderr: "" });
    });
    existsSyncMock.mockReturnValue(true);

    const { findCloudflaredBinary } = await import("./cloudflared.js");
    const result = await findCloudflaredBinary(execMock);
    expect(result).toBe("/usr/local/bin/cloudflared");
  });

  it("falls back to known paths when which fails", async () => {
    execMock.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "which") {
        return Promise.reject(new Error("not found"));
      }
      // --version check for known path
      return Promise.resolve({ stdout: "cloudflared version 2024.1.0\n", stderr: "" });
    });
    existsSyncMock.mockImplementation((p: string) => p === "/usr/local/bin/cloudflared");

    const { findCloudflaredBinary } = await import("./cloudflared.js");
    const result = await findCloudflaredBinary(execMock);
    expect(result).toBe("/usr/local/bin/cloudflared");
  });

  it("returns null when binary is not found", async () => {
    execMock.mockRejectedValue(new Error("not found"));
    existsSyncMock.mockReturnValue(false);

    const { findCloudflaredBinary } = await import("./cloudflared.js");
    const result = await findCloudflaredBinary(execMock);
    expect(result).toBeNull();
  });
});

describe("startCloudflaredTunnel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY;
  });

  function createMockProcess(): ChildProcess {
    const events: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stdoutEvents: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stderrEvents: Record<string, Array<(...args: unknown[]) => void>> = {};

    const mockStdout = {
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stdoutEvents[event] = stdoutEvents[event] ?? [];
        stdoutEvents[event].push(cb);
      }),
    };
    const mockStderr = {
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stderrEvents[event] = stderrEvents[event] ?? [];
        stderrEvents[event].push(cb);
      }),
    };

    return {
      pid: 12345,
      killed: false,
      stdout: mockStdout as unknown as Readable,
      stderr: mockStderr as unknown as Readable,
      kill: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        events[event] = events[event] ?? [];
        events[event].push(cb);
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        events[event] = events[event] ?? [];
        events[event].push(cb);
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of events[event] ?? []) {
          cb(...args);
        }
      },
      _emitStderr: (data: string) => {
        for (const cb of stderrEvents.data ?? []) {
          cb(data);
        }
      },
    } as unknown as ChildProcess & {
      _emit: (event: string, ...args: unknown[]) => void;
      _emitStderr: (data: string) => void;
    };
  }

  it("starts tunnel and parses connector ID", async () => {
    const mockChild = createMockProcess() as ChildProcess & {
      _emit: (event: string, ...args: unknown[]) => void;
      _emitStderr: (data: string) => void;
    };

    spawnMock.mockReturnValue(mockChild);
    process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY = "/usr/local/bin/cloudflared";

    const { startCloudflaredTunnel } = await import("./cloudflared.js");

    const tunnelPromise = startCloudflaredTunnel({
      token: "test-token",
      timeoutMs: 5000,
    });

    // Simulate cloudflared registering a connection
    await new Promise((r) => setTimeout(r, 50));
    mockChild._emitStderr("INF Registered tunnel connection connectorID=abc123-def456");

    const tunnel = await tunnelPromise;
    expect(tunnel.connectorId).toBe("abc123-def456");
    expect(tunnel.pid).toBe(12345);
    expect(typeof tunnel.stop).toBe("function");
  });

  it("throws when tunnel exits before registering", async () => {
    const mockChild = createMockProcess() as ChildProcess & {
      _emit: (event: string, ...args: unknown[]) => void;
      _emitStderr: (data: string) => void;
    };

    spawnMock.mockReturnValue(mockChild);
    process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY = "/usr/local/bin/cloudflared";

    const { startCloudflaredTunnel } = await import("./cloudflared.js");

    const tunnelPromise = startCloudflaredTunnel({
      token: "bad-token",
      timeoutMs: 5000,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockChild._emit("exit", 1, null);

    await expect(tunnelPromise).rejects.toThrow(/cloudflared exited/);
  });
});
