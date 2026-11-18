import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { isWindowsProcessDefinitelyAbsent } from "./windows-process-absent.js";

const execFileSync = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: readonly string[], options?: Record<string, unknown>) => string>(),
);

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: execFileSync,
    default: { ...original.default, execFileSync },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  execFileSync.mockReset();
});

describe("isWindowsProcessDefinitelyAbsent", () => {
  it("claims absence only for the ArgumentException verdict", async () => {
    execFileSync.mockReturnValue("absent");
    await withMockedPlatform("win32", async () => {
      expect(isWindowsProcessDefinitelyAbsent(42)).toBe(true);
    });
  });

  it.each(["present", "unknown", "Absent", ""])(
    "never claims absence from verdict %j",
    async (verdict) => {
      execFileSync.mockReturnValue(verdict);
      await withMockedPlatform("win32", async () => {
        expect(isWindowsProcessDefinitelyAbsent(42)).toBe(false);
      });
    },
  );

  it("claims absence from the not-found verdict with surrounding output whitespace", async () => {
    execFileSync.mockReturnValue("  absent\r\n");
    await withMockedPlatform("win32", async () => {
      expect(isWindowsProcessDefinitelyAbsent(42)).toBe(true);
    });
  });

  it("stays conservative when the probe cannot run", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    await withMockedPlatform("win32", async () => {
      expect(isWindowsProcessDefinitelyAbsent(42)).toBe(false);
    });
  });

  it("passes a bounded timeout and hidden window to PowerShell", async () => {
    execFileSync.mockReturnValue("present");
    await withMockedPlatform("win32", async () => {
      expect(isWindowsProcessDefinitelyAbsent(42)).toBe(false);
      const options = execFileSync.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.timeout).toBe(2_000);
      expect(options.windowsHide).toBe(true);
      expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
      const command = execFileSync.mock.calls[0]?.[1] as string[];
      expect(command.some((arg) => arg.includes("GetProcessById(42)"))).toBe(true);
    });
  });

  it("does not spawn anything off Windows or for invalid pids", async () => {
    await withMockedPlatform("linux", async () => {
      expect(isWindowsProcessDefinitelyAbsent(42)).toBe(false);
    });
    await withMockedPlatform("win32", async () => {
      expect(isWindowsProcessDefinitelyAbsent(0)).toBe(false);
      expect(isWindowsProcessDefinitelyAbsent(-1)).toBe(false);
      expect(isWindowsProcessDefinitelyAbsent(1.5)).toBe(false);
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
