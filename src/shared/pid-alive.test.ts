import "../test-utils/prepare-compiled-subprocesses.ts";
import childProcess from "node:child_process";
import fsSync from "node:fs";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  getFileLockProcessStartTime,
  getProcessInstanceStartTime,
  getProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "./pid-alive.js";

const nativeIdentity = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessIdentity: nativeIdentity,
}));

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
beforeEach(() => {
  vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
  nativeIdentity.mockReset().mockImplementation(() => {
    throw new Error("native identity unavailable");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  readWindowsProcessStartTimeSyncMock.mockReset();
  readFreeBsdProcessStartTimeMock.mockReset();
});

function mockProcReads(entries: Record<string, string | (() => string)>) {
  const originalReadFileSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    const key = String(filePath);
    if (Object.hasOwn(entries, key)) {
      const value = entries[key];
      return (typeof value === "function" ? value() : value) as never;
    }
    return originalReadFileSync(filePath as never, encoding as never) as never;
  });
}

function mockKill(code = "success") {
  return vi.spyOn(process, "kill").mockImplementation(() => {
    if (code !== "success") {
      throw Object.assign(new Error("process probe failed"), { code });
    }
    return true;
  });
}
const invalidPids = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
const liveness = (pid: number) => [isPidAlive(pid), isPidDefinitelyDead(pid)];
const procStatus = (state: string, threads: string, tgid?: number) =>
  `State:\t${state}\nThreads:\t${threads}\n${tgid === undefined ? "" : `Tgid:\t${tgid}\n`}`;
const procStat = (pid: number, start: number, name = "node") =>
  `${pid} (${name}) S ${"0 ".repeat(18)}${start}`;

it("rejects invalid PIDs without probing", () => {
  const kill = mockKill();
  expect(invalidPids.map(liveness)).toEqual(invalidPids.map(() => [false, true]));
  expect(kill).not.toHaveBeenCalled();
});

it.each([
  ["missing PID", "ESRCH", undefined, false, true],
  ["unreadable procfs", "success", undefined, true, false],
  ["live leader", "success", procStatus("S", "2", 42), true, false],
  ["recycled TID", "success", procStatus("S", "2", 41), false, true],
  ["last exited thread", "success", procStatus("X", "1"), false, true],
  ["live sibling threads", "EPERM", procStatus("X", "2"), true, false],
] as const)("Linux liveness: %s", (_name, probe, status, alive, dead) => {
  mockKill(probe);
  mockProcReads({
    "/proc/42/status":
      status ??
      (() => {
        throw new Error("no proc status");
      }),
  });
  withMockedPlatform("linux", () => {
    expect(liveness(42)).toEqual([alive, dead]);
  });
});

it("confirms exit when procfs disappears after the initial existence probe", () => {
  let statusRead = false;
  mockProcReads({
    "/proc/42/status": () => {
      statusRead = true;
      throw Object.assign(new Error("process status unavailable"), { code: "ENOENT" });
    },
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
    mockProcReads({ "/proc/42/status": procStatus("Z", "0") });
    mockKill(result).mockImplementationOnce(() => true);
    withMockedPlatform("linux", () => {
      expect(isPidDefinitelyDead(42)).toBe(result === "ESRCH");
    });
  },
);

describe("process start times", () => {
  it.each(["linux", "android"] as const)("parses %s /proc stat start times", async (platform) => {
    mockProcReads({
      [`/proc/${process.pid}/stat`]: procStat(process.pid, 98765),
      "/proc/42/stat": procStat(42, 55555),
      "/proc/43/stat": "43 node S malformed",
      "/proc/44/stat": procStat(44, 66666, "My App (v2)"),
      "/proc/45/stat": procStat(45, -1),
      "/proc/46/stat": procStat(46, 1.5),
    });

    await withMockedPlatform(platform, async () => {
      expect(getProcessStartTime(process.pid)).toBe(98765);
      expect(getFileLockProcessStartTime(42)).toBe(55555);
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
      const stat = (pid: number) => () => {
        const value = probe(pid);
        if (value === null) {
          throw new Error("process start time unavailable");
        }
        return procStat(pid, value);
      };
      mockProcReads({
        [`/proc/${process.pid}/stat`]: stat(process.pid),
        [`/proc/${foreignPid}/stat`]: stat(foreignPid),
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

describe("native process identity policy", () => {
  const seconds = 1_790_000_000;
  const identity = (startTimeMicros = seconds * 1_000_000 + 123_456) => ({
    pid: 42,
    parentPid: 7,
    startTimeMicros,
    startTimeResolutionMicros: 1,
    exited: false,
  });

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("SEALED_RUNTIME_BUILD", undefined);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    nativeIdentity.mockReset().mockReturnValue(identity());
  });

  it("keeps legacy seconds and fresh custody precision", () => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    expect(getFileLockProcessStartTime(42)).toBe(seconds);
    expect(getProcessInstanceStartTime(42)).toBe(seconds * 1_000_000 + 123_456);
    nativeIdentity.mockReturnValue({ ...identity(seconds * 1_000_000 + 123_457), parentPid: 8 });
    expect(getFileLockProcessStartTime(42)).toBe(seconds);
    expect(getProcessInstanceStartTime(42)).toBe(seconds * 1_000_000 + 123_457);
    expect(shell).not.toHaveBeenCalled();
  });

  it("refuses custody signaling after a same-second process replacement", async () => {
    const { settleCommandProcessGroups } = await import("../process/command-process-custody.js");
    const groups = await import("../process/child-process-tree.js");
    const termination = await import("../process/kill-tree.js");
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValueOnce(true).mockReturnValue(false);
    const kill = vi.spyOn(termination, "killProcessTree").mockReturnValue(undefined);
    const pid = process.pid + 1;
    const startedAt = getProcessInstanceStartTime(pid);
    nativeIdentity.mockReturnValue(identity(seconds * 1_000_000 + 123_457));
    expect(await settleCommandProcessGroups([{ pid, startedAt }])).toMatchObject({
      settled: false,
      pids: [pid],
      reason: expect.stringContaining("Recorded process identity could not be confirmed"),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    { value: null, probe: "success", definitelyDead: true },
    { value: { ...identity(), exited: true }, probe: "ESRCH", definitelyDead: true },
    { value: null, probe: "EPERM", definitelyDead: false },
  ])(
    "does not recover a dead native owner through ps ($probe)",
    ({ value, probe, definitelyDead }) => {
      nativeIdentity.mockReturnValue(value);
      // The synthetic PID must not inherit the host's signal permissions.
      mockKill(probe);
      const shell = vi.spyOn(childProcess, "execFileSync");
      expect(getFileLockProcessStartTime(42)).toBeNull();
      expect(getProcessInstanceStartTime(42)).toBeNull();
      expect(liveness(42)).toEqual([false, definitelyDead]);
      expect(shell).not.toHaveBeenCalled();
    },
  );

  it.each(["darwin", "freebsd", "win32"] as const)(
    "never declares a hidden %s process dead",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      nativeIdentity.mockImplementation(() => {
        throw new ProcSafeError("access-denied", "hidden", {
          details: { reason: "visibility-policy" },
        });
      });
      mockKill("ESRCH");
      expect(liveness(42)).toEqual([true, false]);
    },
  );

  it.each([
    { owner: "absent", value: null, stale: true },
    { owner: "exited", value: { ...identity(), exited: true }, stale: true },
    { owner: "live", value: identity(), stale: false },
    { owner: "protected", value: new ProcSafeError("access-denied", "hidden"), stale: false },
    {
      owner: "unavailable",
      value: new ProcSafeError("helper-unavailable", "missing"),
      stale: false,
    },
  ])("recovers only a proven dead Windows EPERM lock owner ($owner)", async ({ value, stale }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockKill("EPERM");
    nativeIdentity.mockImplementation(() => {
      if (value instanceof Error) {
        throw value;
      }
      return value;
    });
    const { isLockOwnerDefinitelyStale } = await import("../infra/stale-lock-file.js");
    expect(
      isLockOwnerDefinitelyStale({ payload: { pid: 42, createdAt: "2000-01-01T00:00:00Z" } }),
    ).toBe(stale);
  });

  it("keeps sealed helpers on the bounded shell path", () => {
    vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    const shell = vi
      .spyOn(childProcess, "execFileSync")
      .mockReturnValue("Thu Sep 24 00:00:00 2026\n");
    expect(getProcessInstanceStartTime(42)).toBeNull();
    expect(getFileLockProcessStartTime(42)).toBe(Date.UTC(2026, 8, 24) / 1000);
    expect(nativeIdentity).not.toHaveBeenCalled();
    expect(shell.mock.calls[0]?.[2]?.timeout).toBe(1000);
  });

  it("charges unavailable native inspection to the fallback budget", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    nativeIdentity.mockImplementation(() => {
      now += 1000;
      throw new Error("unavailable");
    });
    const shell = vi.spyOn(childProcess, "execFileSync");
    expect(getFileLockProcessStartTime(42, process.env, 1000)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  });
});
