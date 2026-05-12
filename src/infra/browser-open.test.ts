import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserOpenCommand } from "./browser-open.js";
import { _resetWindowsInstallRootsForTests } from "./windows-install-roots.js";

const mocks = vi.hoisted(() => ({
  detectBinary: vi.fn(),
}));

vi.mock("./detect-binary.js", () => ({
  detectBinary: mocks.detectBinary,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetWindowsInstallRootsForTests();
  mocks.detectBinary.mockReset();
});

describe("resolveBrowserOpenCommand", () => {
  it("does not resolve Windows browser launching through a relative SystemRoot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", ".\\fake-root");
    vi.stubEnv("windir", ".\\fake-windir");
    _resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("prefers the registry-backed Windows system root over process env", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" &&
          valueName === "SystemRoot"
        ) {
          return "D:\\Windows";
        }
        return null;
      },
    });

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("D:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("uses the macOS open command even when stale SSH variables are present", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("SSH_CLIENT", "100.64.0.1 12345 22");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    mocks.detectBinary.mockImplementation(async (name: string) => name === "open");

    const resolved = await resolveBrowserOpenCommand();

    expect(resolved).toEqual({ argv: ["open"], command: "open" });
  });

  it("keeps Linux SSH sessions without display on the no-display fallback path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("SSH_CONNECTION", "100.64.0.1 12345 100.64.0.2 22");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");

    const resolved = await resolveBrowserOpenCommand();

    expect(resolved).toEqual({ argv: null, reason: "ssh-no-display" });
    expect(mocks.detectBinary).not.toHaveBeenCalled();
  });
});
