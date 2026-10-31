import { ProcSafeError } from "@openclaw/proc-safe/errors";
import type { ProcessSnapshot } from "@openclaw/proc-safe/inspect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { list, identity, spawn, pin } = vi.hoisted(() => ({
  list: vi.fn(),
  identity: vi.fn(),
  spawn: vi.fn(),
  pin: vi.fn(),
}));
vi.mock("@openclaw/proc-safe/windows-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/windows-job")>()),
  PinnedProcess: { open: pin },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessIdentity: identity,
}));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  listProcesses: list,
}));
import { readWindowsProcessCensus } from "./windows-process-census.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start.js";
import { readWindowsUserSid } from "./windows-user-sid.js";

beforeEach(() => {
  list.mockReset();
  identity.mockReset().mockReturnValue(null);
  spawn.mockReset();
  pin.mockReset().mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function processIdentity(startTimeMicros: number, exited = false, pid = 12) {
  return { pid, parentPid: 100, startTimeMicros, startTimeResolutionMicros: 1, exited };
}
function expectCensus(...entries: ReturnType<typeof readWindowsProcessCensus>) {
  expect(readWindowsProcessCensus(1_000)).toEqual(entries);
}

it("preserves command facts and the existing millisecond start identity", () => {
  const command = {
    executable: "C:\\node.exe",
    argv: ["node", "worker.js"],
    commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
    cwd: "C:\\retained runtime\\工作",
    environment: {},
  };
  list.mockReturnValue([
    { pid: 12, owner: "same", identity: processIdentity(1_725_526_400_000_999), command },
  ] satisfies ProcessSnapshot[]);
  expectCensus({
    pid: 12,
    parentPid: 100,
    startIdentity: "1725526400000",
    executable: command.executable,
    commandLine: command.commandLine,
    cwd: command.cwd,
  });
});

it("reads an opaque process image from an identity-matched limited-query handle", () => {
  const dispose = vi.fn();
  list.mockReturnValue([{ pid: 12, owner: "same", identity: processIdentity(300_000) }]);
  pin.mockReturnValue({
    imagePath: "C:\\Windows\\DefenderSessionHelper.exe",
    [Symbol.dispose]: dispose,
  });
  expectCensus({
    pid: 12,
    parentPid: 100,
    startIdentity: "300",
    executable: "C:\\Windows\\DefenderSessionHelper.exe",
  });
  expect(pin).toHaveBeenCalledWith(12, {
    access: "observe",
    expect: { startTimeMicros: 300_000 },
  });
  expect(dispose).toHaveBeenCalledOnce();
  pin.mockImplementation(() => {
    throw new ProcSafeError("access-denied", "denied");
  });
  expectCensus({ pid: 12, parentPid: 100, startIdentity: "300" });
});

it.each(["same", "different", "unknown"] as const)(
  "retains denied identity and command facts for %s owners",
  (owner) => {
    list.mockReturnValue([{ pid: 12, owner }] satisfies ProcessSnapshot[]);
    expectCensus({ pid: 12, ...(owner === "different" ? { foreignOwner: true } : {}) });
  },
);

it.each(["access-denied", "layout-mismatch"] as const)(
  "distinguishes native %s from an unrelated inaccessible process",
  (code) => {
    list.mockReturnValue([{ pid: 12, owner: "unknown" }]);
    identity.mockImplementation(() => {
      throw new ProcSafeError(code, "Unreadable process");
    });
    expectCensus({ pid: 12, ...(code === "access-denied" ? { accessDenied: true } : {}) });
  },
);

it.each([
  { status: 0, stdout: "S-1-5-21-100\r\n", expected: "S-1-5-21-100" },
  { status: 1, stdout: "S-1-5-21-100", expected: undefined },
  { status: 0, stdout: "unresolved account", expected: undefined },
])("reads the launching token SID ($status, $stdout)", ({ status, stdout, expected }) => {
  mockProcessPlatform("win32");
  spawn.mockReturnValue({ status, stdout });
  expect(readWindowsUserSid()).toBe(expected);
});

it("omits only kernel processes and proven exited identities", () => {
  list.mockReturnValue([
    { pid: 0, owner: "unknown" },
    { pid: 4, owner: "unknown" },
    { pid: 12, owner: "unknown", identity: processIdentity(1_725_526_400_000_999, true) },
    { pid: 13, owner: "unknown" },
  ] satisfies ProcessSnapshot[]);
  expectCensus({ pid: 13 });
});

it("propagates census failure instead of claiming an empty census", () => {
  const error = new ProcSafeError("incomplete", "Census failed");
  list.mockImplementation(() => {
    throw error;
  });
  expect(() => readWindowsProcessCensus(1_000)).toThrow(error);
});

describe("Windows process start identity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    identity.mockImplementation(() => {
      throw new Error("native binding unavailable");
    });
  });
  const expectedTime = Date.parse("2026-07-13T07:20:49.123Z");
  const creationDate = {
    status: 0,
    stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
  };
  function failAfter(ms: number) {
    spawn.mockImplementationOnce(() => {
      vi.advanceTimersByTime(ms);
      return { status: 1, stdout: "" };
    });
  }
  describe("readWindowsProcessStartTimeSync", () => {
    it.each([
      ["exhausted budget", 1000, 1000, null, [1000]],
      ["remaining budget", 600, 1000, expectedTime, [1000, 400]],
      ["default fallback", 5000, undefined, expectedTime, [5000, 5000]],
      ["unavailable creation time", 0, 1000, null, [1000, 1000]],
    ] as const)("handles %s", (_name, elapsed, timeout, expected, budgets) => {
      failAfter(elapsed);
      spawn.mockReturnValueOnce(
        expected === null ? { status: 1, stdout: Buffer.alloc(0) } : creationDate,
      );
      expect(readWindowsProcessStartTimeSync(123, timeout, { SystemRoot: "D:\\Native" })).toBe(
        expected,
      );
      expect(spawn.mock.calls.map((call) => call[2].timeout)).toEqual(budgets);
      expect(spawn.mock.calls.map((call) => call[0])).toEqual([
        "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ...budgets.slice(1).map(() => "D:\\Native\\System32\\wbem\\wmic.exe"),
      ]);
    });

    it.each([-10_000, 10_000])(
      "keeps the WMIC fallback deadline on the monotonic clock across a %d ms wall-clock shift",
      (wallShift) => {
        const dateSpy = vi.spyOn(Date, "now");
        const perfSpy = vi.spyOn(performance, "now");
        const basePerf = performance.now();
        const baseDate = Date.now();
        // PowerShell reports no parseable start time; the wall clock shifts while
        // the monotonic clock advances only slightly between the deadline seed and
        // the remaining read.
        spawn.mockImplementationOnce(() => {
          dateSpy.mockReturnValue(baseDate + wallShift);
          perfSpy.mockReturnValue(basePerf + 10);
          return { status: 1, stdout: "" };
        });
        spawn.mockReturnValueOnce({ status: 0, stdout: creationDate.stdout });
        expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(expectedTime);
        const wmicTimeout = Number(spawn.mock.calls[1]?.[2]?.timeout);
        expect(wmicTimeout).toBeGreaterThanOrEqual(980);
        expect(wmicTimeout).toBeLessThanOrEqual(1000);
        dateSpy.mockRestore();
        perfSpy.mockRestore();
      },
    );

    it.each([0.4, 0.8])(
      "rounds the remaining budget to an integer before spawnSync with fractional elapsed %.1f ms",
      (elapsed) => {
        const perfSpy = vi.spyOn(performance, "now");
        const basePerf = performance.now();
        // PowerShell reports no parseable start time; the monotonic clock advances by
        // a fractional amount, so the raw remaining budget is fractional and must be
        // rounded up before Node's spawnSync validates it.
        spawn.mockImplementationOnce(() => {
          perfSpy.mockReturnValue(basePerf + elapsed);
          return { status: 1, stdout: "" };
        });
        spawn.mockReturnValueOnce({ status: 0, stdout: creationDate.stdout });
        expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(expectedTime);
        for (const call of spawn.mock.calls) {
          expect(Number.isInteger(call[2].timeout)).toBe(true);
          expect(call[2].timeout).toBeGreaterThanOrEqual(980);
          expect(call[2].timeout).toBeLessThanOrEqual(1000);
        }
        perfSpy.mockRestore();
      },
    );
  });

  describe("native Windows process start identity", () => {
    beforeEach(() => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      spawn.mockReturnValue({ status: 0, stdout: "2026-07-13T07:20:49.123Z" });
      identity.mockReturnValue(processIdentity(expectedTime * 1000 + 999, false, 123));
    });

    it("preserves millisecond precision and refreshes foreign process identities", () => {
      expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime);
      identity.mockReturnValue({ startTimeMicros: (expectedTime + 1) * 1000, exited: false });
      expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime + 1);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("does not recover exited owners with a shell", () => {
      identity.mockReturnValue({ exited: true });
      expect(readWindowsProcessStartTimeSync(123)).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("keeps sealed helpers independent of installed native packages", () => {
      vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
      expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime);
      expect(identity).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it.each([0, 1.5, 0x1_0000_0000])(
      "rejects PID %s before native conversion or shell query",
      (pid) => {
        expect(readWindowsProcessStartTimeSync(pid)).toBeNull();
        expect(identity).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      },
    );

    it("charges native initialization to the fallback deadline", () => {
      identity.mockImplementation(() => {
        vi.advanceTimersByTime(1000);
        throw new Error("native unavailable");
      });
      expect(readWindowsProcessStartTimeSync(123, 1000)).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
