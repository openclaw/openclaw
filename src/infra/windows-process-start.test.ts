import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";
import {
  readWindowsProcessAncestorsSync,
  readWindowsProcessStartTimeSync,
} from "./windows-process-start.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const nativeIdentity = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessIdentity: nativeIdentity,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

describe("readWindowsProcessStartTimeSync", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    nativeIdentity.mockReset().mockImplementation(() => {
      throw new Error("native binding unavailable");
    });
  });

  it("reads an ISO creation time through PowerShell", () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "2026-07-13T07:20:49.1234567Z",
    } as never);

    expect(readWindowsProcessStartTimeSync(123, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("projects supplied native context with Windows key precedence for both queries", () => {
    const env = {
      SYSTEMROOT: "D:\\Native",
      SystemRoot: "E:\\Ignored",
      WINDIR: "F:\\Ignored",
      PATH: "native-path",
      PSModuleAnalysisCachePath: "D:\\NativeCache",
      DIAGNOSTIC_NEUTRAL_CANARY: "synthetic",
      NODE_OPTIONS: "--synthetic-injection-must-not-be-inherited",
    };
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    });
    expect(readWindowsProcessStartTimeSync(456, 1000, env)).toBe(
      Date.parse("2026-07-13T07:20:49.123Z"),
    );
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("D:\\Native\\System32\\wbem\\wmic.exe");
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[2].env).toEqual({
        SYSTEMROOT: "D:\\Native",
        WINDIR: "F:\\Ignored",
        PATH: "native-path",
        PSModuleAnalysisCachePath: "D:\\NativeCache",
      });
      expect(call[2].timeout).toBeLessThanOrEqual(1000);
    }
    expect(env.SystemRoot).toBe("E:\\Ignored");
    expect(env.DIAGNOSTIC_NEUTRAL_CANARY).toBe("synthetic");
  });

  it("does not start WMIC once PowerShell has spent the whole budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock.mockImplementationOnce(() => {
        vi.advanceTimersByTime(1000);
        return { status: 1, stdout: "" };
      });

      expect(readWindowsProcessStartTimeSync(321, 1000)).toBeNull();
      // A second full-budget probe here would block a synchronous caller for
      // twice the timeout it asked for before returning this same null.
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives WMIC only the time left on the caller's budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(600);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(654, 1000)).toBe(
        Date.parse("2026-07-13T07:20:49.123Z"),
      );
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 400 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the default WMIC fallback after PowerShell spends five seconds", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(5000);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(987)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
      expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 5000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when process creation time is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) } as never);

    expect(readWindowsProcessStartTimeSync(789, 1000)).toBeNull();
    expect(readWindowsProcessStartTimeSync(0, 1000)).toBeNull();
  });
});

describe("native Windows process start identity", () => {
  const expectedTime = Date.parse("2026-07-13T07:20:49.123Z");
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    spawnSyncMock.mockReset().mockReturnValue({ status: 0, stdout: "2026-07-13T07:20:49.123Z" });
    nativeIdentity.mockReset().mockReturnValue({
      pid: 123,
      parentPid: 1,
      startTimeMicros: expectedTime * 1000 + 999,
      startTimeResolutionMicros: 1,
      exited: false,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("preserves millisecond precision and refreshes foreign process identities", () => {
    expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime);
    nativeIdentity.mockReturnValue({ startTimeMicros: (expectedTime + 1) * 1000, exited: false });
    expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime + 1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([null, { exited: true }])(
    "does not recover absent or exited owners with a shell",
    (value) => {
      nativeIdentity.mockReturnValue(value);
      expect(readWindowsProcessStartTimeSync(123)).toBeNull();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("keeps sealed helpers independent of installed native packages", () => {
    vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime);
    expect(nativeIdentity).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity])(
    "rejects PID %s before native conversion or shell query",
    (pid) => {
      expect(readWindowsProcessStartTimeSync(pid)).toBeNull();
      expect(nativeIdentity).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each([600, 1000])("charges %sms native initialization to the fallback deadline", (elapsed) => {
    vi.useFakeTimers();
    nativeIdentity.mockImplementation(() => {
      vi.advanceTimersByTime(elapsed);
      throw new Error("native unavailable");
    });
    expect(readWindowsProcessStartTimeSync(123, 1000)).toBe(elapsed === 1000 ? null : expectedTime);
    if (elapsed === 1000) {
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } else {
      expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 400 });
    }
  });
});

describe("readWindowsProcessAncestorsSync", () => {
  const child = { pid: 41, parentPid: 40, startedAt: "639000000000000030" };
  const parent = { pid: 40, parentPid: 39, startedAt: "639000000000000020" };
  const grandparent = { pid: 39, parentPid: 0, startedAt: "639000000000000010" };

  beforeEach(() => spawnSyncMock.mockReset());

  it("reads the chain with one bounded native query and no application environment", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([child, parent, grandparent]),
    });
    expect(
      readWindowsProcessAncestorsSync(41, 32, 700, {
        SYSTEMROOT: "D:\\Native",
        NODE_OPTIONS: "--synthetic-injection",
      }),
    ).toEqual({ pids: [40, 39], complete: true });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({
      timeout: 700,
      maxBuffer: 1024 * 1024,
      env: { SYSTEMROOT: "D:\\Native" },
    });
  });

  it.each([
    {
      name: "reused grandparent within the same millisecond",
      rows: [child, parent, { ...grandparent, startedAt: "639000000000000021" }],
      expected: [40],
    },
    {
      name: "unobservable parent creation time",
      rows: [child, { ...parent, startedAt: null }, grandparent],
      expected: [],
    },
    { name: "missing parent", rows: [child, grandparent], expected: [] },
    {
      name: "duplicate process identity",
      rows: [child, parent, grandparent, { ...grandparent, startedAt: "639000000000000021" }],
      expected: [],
    },
  ])("stops at $name", ({ rows, expected }) => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify(rows) });
    expect(readWindowsProcessAncestorsSync(41, 32, 700)).toEqual({
      pids: expected,
      complete: false,
    });
  });

  it("bounds the walk and never repeats an ancestor from a cyclic snapshot", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        child,
        { ...parent, startedAt: child.startedAt },
        { ...grandparent, parentPid: 40, startedAt: child.startedAt },
      ]),
    });
    expect(readWindowsProcessAncestorsSync(41, 1, 700)).toEqual({ pids: [40], complete: false });
    expect(readWindowsProcessAncestorsSync(41, 32, 700)).toEqual({
      pids: [40, 39],
      complete: false,
    });
  });

  it.each([
    { status: null, error: new Error("timeout"), stdout: "" },
    { status: 0, stdout: "not JSON" },
  ])("does not invent ancestry after an unavailable query", (result) => {
    spawnSyncMock.mockReturnValue(result);
    expect(readWindowsProcessAncestorsSync(41, 32, 700)).toEqual({ pids: [], complete: false });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
