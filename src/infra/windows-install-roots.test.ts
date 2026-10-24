import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const installRoots = {
  systemRoot: "D:\\Windows",
  programFiles: "E:\\Programs",
  programFilesX86: "F:\\Programs (x86)",
  programW6432: "E:\\Programs",
};

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});
import {
  getWindowsInstallRoots,
  getWindowsPowerShellExePath,
  getWindowsProgramFilesRoots,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

describe("getWindowsInstallRoots", () => {
  it("prefers HKLM registry roots over process environment values", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation((_file, args: string[]) => {
      const valueName = args[3];
      const values: Record<string, string> = {
        SystemRoot: installRoots.systemRoot,
        ProgramFilesDir: installRoots.programFiles,
        "ProgramFilesDir (x86)": installRoots.programFilesX86,
        ProgramW6432Dir: installRoots.programW6432,
      };
      const value = valueName ? values[valueName] : undefined;
      return value ? `${valueName}    REG_SZ    ${value}\r\n` : "";
    });
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    vi.stubEnv("ProgramFiles", "C:\\Poisoned Programs");
    vi.stubEnv("ProgramFiles(x86)", "C:\\Poisoned Programs (x86)");
    vi.stubEnv("ProgramW6432", "C:\\Poisoned Programs");
    const roots = getWindowsInstallRoots();

    expect(roots).toEqual(installRoots);
    expect(execFileSyncMock).toHaveBeenCalled();
    for (const [file] of execFileSyncMock.mock.calls) {
      expect(file).toBe("C:\\Windows\\System32\\reg.exe");
    }
  });

  it("retains first-lookup environment fallbacks when Program Files is requested later", async () => {
    vi.resetModules();
    const roots = await import("./windows-install-roots.js");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    execFileSyncMock.mockReturnValue("");
    const env = {
      SystemRoot: "relative\\Windows",
      WINDIR: installRoots.systemRoot,
      ProgramFiles: installRoots.programFiles,
      "ProgramFiles(x86)": installRoots.programFilesX86,
      ProgramW6432: "G:\\Programs",
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    expect(roots.getWindowsCmdExePath()).toBe("D:\\Windows\\System32\\cmd.exe");

    for (const key of Object.keys(env)) {
      vi.stubEnv(key, "Z:\\Changed");
    }
    const cached = roots.getWindowsInstallRoots();
    expect(cached).toEqual({ ...installRoots, programW6432: "G:\\Programs" });
    expect(roots.getWindowsInstallRoots()).toBe(cached);
    expect(roots.getWindowsCmdExePath()).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("falls back to defaults when registry and env roots are invalid", () => {
    const roots = getWindowsInstallRoots({
      SystemRoot: "relative\\Windows",
      ProgramFiles: "\\\\server\\share\\Program Files",
      "ProgramFiles(x86)": "D:\\",
      ProgramW6432: "C:\\Programs;D:\\Other",
    });

    expect(roots).toEqual({
      systemRoot: "C:\\Windows",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      programW6432: null,
    });
  });
});

describe("getWindowsProgramFilesRoots", () => {
  it("prefers ProgramW6432 and dedupes roots case-insensitively", () => {
    expect(
      getWindowsProgramFilesRoots({
        ProgramW6432: "D:\\Programs",
        ProgramFiles: "d:\\Programs\\",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      }),
    ).toEqual(["D:\\Programs", "E:\\Programs (x86)"]);
  });
});

describe("Windows system executable helpers", () => {
  it("resolves trusted Windows process-inspection tools", () => {
    const env = { SystemRoot: "D:\\Windows" };

    expect(getWindowsSystem32ExePath("netstat.exe", env)).toBe(
      "D:\\Windows\\System32\\netstat.exe",
    );
    expect(getWindowsPowerShellExePath(env)).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(getWindowsWmicExePath(env)).toBe("D:\\Windows\\System32\\wbem\\wmic.exe");
  });

  it("rejects unsafe System32 executable names", () => {
    expect(() => getWindowsSystem32ExePath("..\\netstat.exe")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
    expect(() => getWindowsSystem32ExePath("netstat")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
  });
});
