import childProcess from "node:child_process";
import fsSync from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  getFileLockProcessStartTime,
  getProcessInstanceStartTime,
  getProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
  readDarwinProcessIdentity,
} from "./pid-alive.js";

const nativeKoffi = vi.hoisted(() => vi.fn());
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return (id: string) => (id === "koffi" ? nativeKoffi() : require(id));
    },
  };
});

const readWindowsProcessStartTimeSyncMock = vi.hoisted(() =>
  vi.fn<(pid: number) => number | null>(() => null),
);
const readFreeBsdProcessStartTimeMock = vi.hoisted(() =>
  vi.fn<(pid: number) => number | null>(() => null),
);

vi.mock("./freebsd-process-identity.ts", () => ({
  readFreeBsdProcessStartTime: readFreeBsdProcessStartTimeMock,
}));

vi.mock("../infra/windows-process-start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/windows-process-start.js")>()),
  readWindowsProcessStartTimeSync: readWindowsProcessStartTimeSyncMock,
}));

// Portable cases disable native inspection; the native suite opts back in.
beforeEach(() => vi.stubGlobal("SEALED_RUNTIME_BUILD", true));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  readWindowsProcessStartTimeSyncMock.mockReset();
  readFreeBsdProcessStartTimeMock.mockReset();
});

function mockProcReads(entries: Record<string, string>) {
  const originalReadFileSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    const key = String(filePath);
    if (Object.hasOwn(entries, key)) {
      return entries[key] as never;
    }
    return originalReadFileSync(filePath as never, encoding as never) as never;
  });
}

describe("isPidAlive", () => {
  it("returns false for invalid PIDs", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("returns false when process probing reports ESRCH", () => {
    const error = Object.assign(new Error("missing process"), { code: "ESRCH" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });

    expect(isPidAlive(42)).toBe(false);
    expect(process["kill"]).toHaveBeenCalledWith(42, 0);
  });

  it("treats unreadable linux proc status as non-zombie when kill succeeds", async () => {
    const readFileSyncSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
      throw new Error("no proc status");
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      expect(isPidAlive(42)).toBe(true);
    });

    expect(readFileSyncSpy).toHaveBeenCalledWith("/proc/42/status", "utf8");
    expect(killSpy).toHaveBeenCalledWith(42, 0);
  });
});

describe("isPidDefinitelyDead", () => {
  it("returns true for invalid PIDs", () => {
    expect(isPidDefinitelyDead(0)).toBe(true);
    expect(isPidDefinitelyDead(-1)).toBe(true);
    expect(isPidDefinitelyDead(1.5)).toBe(true);
    expect(isPidDefinitelyDead(Number.NaN)).toBe(true);
    expect(isPidDefinitelyDead(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("Linux process liveness", () => {
  it.each([
    { probe: "success", state: "X", threads: "1", dead: true },
    { probe: "EPERM", state: "X", threads: "2", dead: false },
  ])(
    "requires exited threads (probe=$probe, state=$state, threads=$threads)",
    async ({ probe, state, threads, dead }) => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (probe === "EPERM") {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return true;
      });
      mockProcReads({
        "/proc/42/status": `Name:\tnode\nState:\t${state}\n${threads ? `Threads:\t${threads}\n` : ""}`,
      });
      await withMockedPlatform("linux", async () => {
        expect(isPidAlive(42)).toBe(!dead);
        expect(isPidDefinitelyDead(42)).toBe(dead && probe !== "EPERM");
      });
    },
  );
});

it("confirms exit when procfs disappears after the initial existence probe", () => {
  let statusRead = false;
  const originalReadFileSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
    if (String(args[0]) !== "/proc/42/status") {
      return originalReadFileSync(...args);
    }
    statusRead = true;
    throw Object.assign(new Error("process status unavailable"), { code: "ENOENT" });
  });
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (!statusRead) {
      return true;
    }
    throw Object.assign(new Error("process probe failed"), { code: "ESRCH" });
  });
  withMockedPlatform("linux", () => {
    expect(isPidAlive(42)).toBe(false);
  });
});

it.each(["ESRCH", "EPERM", "success"])(
  "revalidates a zero-thread Linux snapshot (fresh probe=%s)",
  (result) => {
    mockProcReads({ "/proc/42/status": "Name:\tnode\nState:\tZ\nThreads:\t0\n" });
    vi.spyOn(process, "kill")
      .mockImplementationOnce(() => true)
      .mockImplementation(() => {
        if (result === "success") {
          return true;
        }
        throw Object.assign(new Error("current PID probe failed"), { code: result });
      });
    withMockedPlatform("linux", () => {
      expect(isPidDefinitelyDead(42)).toBe(result === "ESRCH");
    });
  },
);

describe("process start times", () => {
  it("parses linux /proc stat start times and rejects malformed variants", async () => {
    const fakeStatPrefix = "42 (node) S 1 42 42 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 ";
    const fakeStatSuffix =
      " 123456789 5000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
    mockProcReads({
      [`/proc/${process.pid}/stat`]: `${process.pid} (node) S 1 ${process.pid} ${process.pid} 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 98765 123456789 5000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`,
      "/proc/42/stat": `${fakeStatPrefix}55555${fakeStatSuffix}`,
      "/proc/43/stat": "43 node S malformed",
      "/proc/44/stat": `44 (My App (v2)) S 1 44 44 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 66666 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`,
      "/proc/45/stat": `${fakeStatPrefix}-1${fakeStatSuffix}`,
      "/proc/46/stat": `${fakeStatPrefix}1.5${fakeStatSuffix}`,
    });

    await withMockedPlatform("linux", async () => {
      expect(getProcessStartTime(process.pid)).toBe(98765);
      expect(getProcessStartTime(42)).toBe(55555);
      expect(getProcessInstanceStartTime(42)).toBe(55555);
      expect(getProcessStartTime(43)).toBeNull();
      expect(getProcessStartTime(44)).toBe(66666);
      expect(getProcessStartTime(45)).toBeNull();
      expect(getProcessStartTime(46)).toBeNull();
    });
  });

  it("reads Windows file-lock identity through the canonical reader", () => {
    readWindowsProcessStartTimeSyncMock.mockReturnValue(1_752_000_000_123);

    return withMockedPlatform("win32", async () => {
      expect(getProcessStartTime(42)).toBeNull();
      expect(getFileLockProcessStartTime(42)).toBe(1_752_000_000_123);
      expect(getProcessInstanceStartTime(42)).toBeNull();
    });
  });

  it.each(["linux", "freebsd"] as const)(
    "retries failed self probes and keeps foreign %s identities fresh",
    async (platform) => {
      const identity = platform === "linux" ? 0 : 1_752_000_000;
      const foreignPid = process.pid + 1;
      const probe = vi
        .fn<(pid: number) => number | null>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(identity)
        .mockReturnValueOnce(111)
        .mockReturnValueOnce(222);
      readFreeBsdProcessStartTimeMock.mockImplementation(probe);
      const originalReadFileSync = fsSync.readFileSync;
      vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
        const pid = /^\/proc\/(\d+)\/stat$/.exec(String(filePath))?.[1];
        if (!pid) {
          return originalReadFileSync(filePath as never, encoding as never) as never;
        }
        const value = probe(Number(pid));
        if (value === null) {
          throw new Error("process start time unavailable");
        }
        return `${pid} (node) S ${"0 ".repeat(18)}${value}` as never;
      });

      await withMockedPlatform(platform, async () => {
        // Each simulated platform needs a fresh module's process-lifetime state.
        vi.resetModules();
        const { getFileLockProcessStartTime: readIdentity } = await import("./pid-alive.js");
        expect(readIdentity(process.pid)).toBeNull();
        expect(readIdentity(process.pid)).toBe(identity);
        expect(readIdentity(process.pid)).toBe(identity);
        expect(readIdentity(foreignPid)).toBe(111);
        expect(readIdentity(foreignPid)).toBe(222);
        expect(readIdentity(process.pid)).toBe(identity);
        expect(probe).toHaveBeenCalledTimes(4);
      });
    },
  );
});

describe("Darwin combined process identity", () => {
  it.each([
    "43 1 Thu Sep 24 00:00:00 2026\n",
    "42 1 Thu Sep 24 00:00:00 2026\n43 1 Thu Sep 24 00:00:00 2026\n",
    "42 1 Thu Feb 31 00:00:00 2026\n",
  ])("does not adopt incomplete or inconsistent metadata: %j", (stdout) => {
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(stdout);
    withMockedPlatform("darwin", () => {
      expect(readDarwinProcessIdentity(42)).toBeNull();
    });
  });
});

describe("Darwin native process identity", () => {
  const seconds = 1_790_000_000;
  let bytes: Buffer;
  const query = vi.fn();
  const load = vi.fn();

  function mockShellIdentity() {
    return vi
      .spyOn(childProcess, "execFileSync")
      .mockImplementation((_file, args) =>
        args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
      );
  }

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("SEALED_RUNTIME_BUILD", undefined);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    bytes = Buffer.alloc(136);
    bytes.writeUInt32LE(42, 12);
    bytes.writeUInt32LE(7, 16);
    bytes.writeBigUInt64LE(BigInt(seconds), 120);
    bytes.writeBigUInt64LE(999_999n, 128);
    query.mockReset().mockImplementation((_pid, _flavor, _arg, output: Buffer) => {
      bytes.copy(output);
      return bytes.length;
    });
    load.mockReset().mockReturnValue({ func: () => query });
    nativeKoffi.mockReset().mockReturnValue({ load });
  });

  it("reads fresh Darwin identities without process startup on arm64", async () => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    const identity = await import("./pid-alive.js");
    expect(identity.getFileLockProcessStartTime(42)).toBe(seconds);
    bytes.writeBigUInt64LE(BigInt(seconds + 1), 120);
    bytes.writeUInt32LE(8, 16);
    expect(identity.getFileLockProcessStartTime(42)).toBe(seconds + 1);
    expect(identity.readDarwinProcessIdentity(42)).toEqual({
      parentPid: 8,
      startedAt: seconds + 1,
    });
    expect(shell).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith("/usr/lib/libproc.dylib");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]).toEqual([42, 3, 0, expect.any(Buffer), 136]);
  });

  it("refuses custody signaling after a same-second Darwin process replacement", async () => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    const identity = await import("./pid-alive.js");
    const { settleCommandProcessGroups } = await import("../process/command-process-custody.js");
    const groups = await import("../process/child-process-tree.js");
    const termination = await import("../process/kill-tree.js");
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValueOnce(true).mockReturnValue(false);
    const kill = vi.spyOn(termination, "killProcessTree").mockReturnValue(undefined);

    const pid = process.pid + 1;
    bytes.writeUInt32LE(pid, 12);
    bytes.writeBigUInt64LE(123_456n, 128);
    const startedAt = identity.getProcessInstanceStartTime(pid);
    expect(startedAt).toBe(seconds * 1_000_000 + 123_456);
    expect(identity.getFileLockProcessStartTime(pid)).toBe(seconds);
    bytes.writeBigUInt64LE(123_457n, 128);
    expect(identity.getFileLockProcessStartTime(pid)).toBe(seconds);
    expect(identity.getProcessInstanceStartTime(pid)).toBe(seconds * 1_000_000 + 123_457);
    expect(await settleCommandProcessGroups([{ pid, startedAt }])).toMatchObject({
      settled: false,
      pids: [pid],
      reason: expect.stringContaining("Recorded process identity could not be confirmed"),
    });
    expect(kill).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  });

  it("refuses an unsafe microsecond identity without changing the lease timestamp", async () => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    const identity = await import("./pid-alive.js");
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    bytes.writeBigUInt64LE(maximum / 1_000_000n, 120);
    bytes.writeBigUInt64LE(maximum % 1_000_000n, 128);
    expect(identity.getProcessInstanceStartTime(42)).toBe(Number.MAX_SAFE_INTEGER);
    bytes.writeBigUInt64LE((maximum % 1_000_000n) + 1n, 128);
    expect(identity.getProcessInstanceStartTime(42)).toBeNull();
    expect(identity.getFileLockProcessStartTime(42)).toBe(Number(maximum / 1_000_000n));
    expect(shell).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["x64", () => vi.spyOn(process, "arch", "get").mockReturnValue("x64")],
    ["sealed runtime", () => vi.stubGlobal("SEALED_RUNTIME_BUILD", true)],
  ])("keeps %s on the bounded shell path without loading Koffi", async (_name, configure) => {
    configure();
    const shell = vi
      .spyOn(childProcess, "execFileSync")
      .mockReturnValue("Thu Sep 24 00:00:00 2026\n");
    const identity = await import("./pid-alive.js");
    expect(identity.getProcessInstanceStartTime(42)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
    expect(identity.getFileLockProcessStartTime(42)).toBe(Date.UTC(2026, 8, 24) / 1000);
    expect(nativeKoffi).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["short read", () => query.mockReturnValue(135)],
    ["wrong PID", () => bytes.writeUInt32LE(43, 12)],
    ["invalid microseconds", () => bytes.writeBigUInt64LE(1_000_000n, 128)],
  ])("uses the bounded shell fallback after %s", async (_name, failNative) => {
    failNative();
    const shell = mockShellIdentity();
    const identity = await import("./pid-alive.js");
    const expected = Date.UTC(2026, 8, 24) / 1000;
    expect(identity.getProcessInstanceStartTime(42)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
    expect(identity.getFileLockProcessStartTime(42)).toBe(expected);
    expect(identity.readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: expected });
    expect(shell).toHaveBeenCalledTimes(2);
    for (const call of shell.mock.calls) {
      expect(call[2]?.timeout).toBeGreaterThan(0);
      expect(call[2]?.timeout).toBeLessThanOrEqual(1000);
    }
    shell.mockImplementation(() => {
      throw new Error("process absent");
    });
    expect(identity.getFileLockProcessStartTime(42)).toBeNull();
    expect(identity.readDarwinProcessIdentity(42)).toBeNull();
  });

  it("does not start shell recovery after native loading consumes the allowance", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    nativeKoffi.mockImplementation(() => {
      now += 1000;
      throw new Error("native unavailable");
    });
    const shell = mockShellIdentity();
    const identity = await import("./pid-alive.js");
    expect(identity.getFileLockProcessStartTime(42, process.env, 1000)).toBeNull();
    expect(identity.readDarwinProcessIdentity(42, process.env, 1000)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects an invalid PID before native conversion", async () => {
    const pid = 0;
    const shell = vi.spyOn(childProcess, "execFileSync");
    const identity = await import("./pid-alive.js");
    expect(identity.getFileLockProcessStartTime(pid)).toBeNull();
    expect(identity.readDarwinProcessIdentity(pid)).toBeNull();
    expect(nativeKoffi).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  });
});
