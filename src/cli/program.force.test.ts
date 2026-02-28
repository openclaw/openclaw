import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const tryListenOnPortMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/ports-probe.js", () => ({
  tryListenOnPort: (...args: unknown[]) => tryListenOnPortMock(...args),
}));

import { execFileSync } from "node:child_process";
import {
  forceFreePort,
  forceFreePortAndWait,
  listPortListeners,
  type PortProcess,
  parseLsofOutput,
} from "./ports.js";

describe("gateway --force helpers", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
    tryListenOnPortMock.mockReset();
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("parses lsof output into pid/command pairs", () => {
    const sample = ["p123", "cnode", "p456", "cpython", ""].join("\n");
    const parsed = parseLsofOutput(sample);
    expect(parsed).toEqual<PortProcess[]>([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("returns empty list when lsof finds nothing", () => {
    (execFileSync as unknown as Mock).mockImplementation(() => {
      const err = new Error("no matches") as NodeJS.ErrnoException & { status?: number };
      err.status = 1; // lsof uses exit 1 for no matches
      throw err;
    });
    expect(listPortListeners(18789)).toEqual([]);
  });

  it("throws when lsof missing", () => {
    (execFileSync as unknown as Mock).mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => listPortListeners(18789)).toThrow(/lsof not found/);
  });

  it("kills each listener and returns metadata", () => {
    (execFileSync as unknown as Mock).mockReturnValue(
      ["p42", "cnode", "p99", "cssh", ""].join("\n"),
    );
    const killMock = vi.fn();
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(execFileSync).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
  });

  it("retries until the port is free", async () => {
    vi.useFakeTimers();
    let call = 0;
    (execFileSync as unknown as Mock).mockImplementation(() => {
      call += 1;
      // 1st call: initial listeners to kill.
      // 2nd/3rd calls: still listed.
      // 4th call: gone.
      if (call === 1) {
        return ["p42", "cnode", ""].join("\n");
      }
      if (call === 2 || call === 3) {
        return ["p42", "cnode", ""].join("\n");
      }
      return "";
    });

    const killMock = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      sigtermTimeoutMs: 400,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(res.killed).toEqual<PortProcess[]>([{ pid: 42, command: "node" }]);
    expect(res.escalatedToSigkill).toBe(false);
    expect(res.waitedMs).toBe(100);

    vi.useRealTimers();
  });

  it("escalates to SIGKILL if SIGTERM doesn't free the port", async () => {
    vi.useFakeTimers();
    let call = 0;
    (execFileSync as unknown as Mock).mockImplementation(() => {
      call += 1;
      // 1st call: initial kill list; then keep showing until after SIGKILL.
      if (call <= 7) {
        return ["p42", "cnode", ""].join("\n");
      }
      return "";
    });

    const killMock = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 800,
      intervalMs: 100,
      sigtermTimeoutMs: 300,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(42, "SIGKILL");
    expect(res.escalatedToSigkill).toBe(true);

    vi.useRealTimers();
  });

  it("falls back to fuser when lsof is permission denied", async () => {
    (execFileSync as unknown as Mock).mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return "18789/tcp: 4242\n";
    });
    tryListenOnPortMock.mockResolvedValue(undefined);

    const result = await forceFreePortAndWait(18789, { timeoutMs: 500, intervalMs: 100 });

    expect(result.escalatedToSigkill).toBe(false);
    expect(result.killed).toEqual<PortProcess[]>([{ pid: 4242 }]);
    expect(execFileSync).toHaveBeenCalledWith(
      "fuser",
      ["-k", "-TERM", "18789/tcp"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("uses fuser SIGKILL escalation when port stays busy", async () => {
    vi.useFakeTimers();
    (execFileSync as unknown as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (args.includes("-TERM")) {
        return "18789/tcp: 1337\n";
      }
      if (args.includes("-KILL")) {
        return "18789/tcp: 1337\n";
      }
      return "";
    });

    const busyErr = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    tryListenOnPortMock
      .mockRejectedValueOnce(busyErr)
      .mockRejectedValueOnce(busyErr)
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValueOnce(undefined);

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 300,
      intervalMs: 100,
      sigtermTimeoutMs: 100,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.escalatedToSigkill).toBe(true);
    expect(result.waitedMs).toBe(100);
    expect(execFileSync).toHaveBeenCalledWith(
      "fuser",
      ["-k", "-KILL", "18789/tcp"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    vi.useRealTimers();
  });

  it("throws when lsof is unavailable and fuser is missing", async () => {
    (execFileSync as unknown as Mock).mockImplementation((cmd: string) => {
      const err = new Error(`spawnSync ${cmd} ENOENT`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    await expect(forceFreePortAndWait(18789, { timeoutMs: 200, intervalMs: 100 })).rejects.toThrow(
      /fuser not found/i,
    );
  });
});
