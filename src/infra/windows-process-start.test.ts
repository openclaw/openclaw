import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWindowsProcessStartTimeSync } from "./windows-process-start.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const nativeIdentity = vi.hoisted(() => vi.fn());
const expectedTime = Date.parse("2026-07-13T07:20:49.123Z");
const creationDate = {
  status: 0,
  stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
};
function failAfter(ms: number) {
  spawnSyncMock.mockImplementationOnce(() => {
    vi.advanceTimersByTime(ms);
    return { status: 1, stdout: "" };
  });
}
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
    vi.useFakeTimers();
    spawnSyncMock.mockReset();
    nativeIdentity.mockReset().mockImplementation(() => {
      throw new Error("native binding unavailable");
    });
  });
  afterEach(() => vi.useRealTimers());

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
    failAfter(600);
    spawnSyncMock.mockReturnValueOnce(creationDate);
    expect(readWindowsProcessStartTimeSync(456, 1000, env)).toBe(expectedTime);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("D:\\Native\\System32\\wbem\\wmic.exe");
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 1000 });
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 400 });
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
    failAfter(1000);
    expect(readWindowsProcessStartTimeSync(321, 1000)).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the default WMIC fallback after PowerShell spends five seconds", () => {
    failAfter(5000);
    spawnSyncMock.mockReturnValueOnce(creationDate);
    expect(readWindowsProcessStartTimeSync(987)).toBe(expectedTime);
    expect(spawnSyncMock.mock.calls.map((call) => call[2].timeout)).toEqual([5000, 5000]);
  });

  it("returns null when process creation time is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) });

    expect(readWindowsProcessStartTimeSync(789, 1000)).toBeNull();
    expect(readWindowsProcessStartTimeSync(0, 1000)).toBeNull();
  });
});

describe("native Windows process start identity", () => {
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

  it("does not recover exited owners with a shell", () => {
    nativeIdentity.mockReturnValue({ exited: true });
    expect(readWindowsProcessStartTimeSync(123)).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("keeps sealed helpers independent of installed native packages", () => {
    vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    expect(readWindowsProcessStartTimeSync(123)).toBe(expectedTime);
    expect(nativeIdentity).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1.5, 0x1_0000_0000])(
    "rejects PID %s before native conversion or shell query",
    (pid) => {
      expect(readWindowsProcessStartTimeSync(pid)).toBeNull();
      expect(nativeIdentity).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("charges native initialization to the fallback deadline", () => {
    vi.useFakeTimers();
    nativeIdentity.mockImplementation(() => {
      vi.advanceTimersByTime(1000);
      throw new Error("native unavailable");
    });
    expect(readWindowsProcessStartTimeSync(123, 1000)).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
