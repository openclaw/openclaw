// Covers platform browser-open command resolution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

type DetectBinary = typeof import("./detect-binary.js").detectBinary;

const { detectBinaryMock, execFileSyncMock, readFileMock, runCommandWithTimeoutMock } = vi.hoisted(
  () => ({
    detectBinaryMock: vi.fn<DetectBinary>(async () => false),
    execFileSyncMock: vi.fn<(file: string, args: readonly string[]) => string>(() => ""),
    readFileMock: vi.fn(async () => "6.8.0-generic"),
    runCommandWithTimeoutMock: vi.fn<() => Promise<SpawnResult>>(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    })),
  }),
);

vi.mock("./detect-binary.js", () => ({
  detectBinary: detectBinaryMock,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: { ...actual, readFile: readFileMock },
    readFile: readFileMock,
  };
});

let detectBrowserOpenSupport: typeof import("./browser-open.js").detectBrowserOpenSupport;
let openUrl: typeof import("./browser-open.js").openUrl;
let resolveBrowserOpenCommand: typeof import("./browser-open.js").resolveBrowserOpenCommand;

beforeEach(async () => {
  vi.resetModules();
  ({ detectBrowserOpenSupport, openUrl, resolveBrowserOpenCommand } =
    await import("./browser-open.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  detectBinaryMock.mockReset().mockResolvedValue(false);
  execFileSyncMock.mockReset().mockReturnValue("");
  readFileMock.mockReset().mockResolvedValue("6.8.0-generic");
  runCommandWithTimeoutMock.mockReset().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
});

describe("openUrl", () => {
  it("returns true after a normal zero exit", async () => {
    mockProcessPlatform("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await expect(openUrl("https://example.com/")).resolves.toBe(true);
  });

  it("returns false after a non-zero exit", async () => {
    mockProcessPlatform("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "browser opener failed",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(openUrl("https://example.com/")).resolves.toBe(false);
  });

  it("returns false after a timeout", async () => {
    mockProcessPlatform("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 124,
      signal: null,
      killed: true,
      termination: "timeout",
    });

    await expect(openUrl("https://example.com/")).resolves.toBe(false);
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("retains process-level WSL detection caching through the resolver", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    vi.stubEnv("WSL_INTEROP", "");
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("WSLENV", "");
    vi.stubEnv("SSH_CLIENT", "");
    vi.stubEnv("SSH_CONNECTION", "");
    vi.stubEnv("SSH_TTY", "");

    await expect(resolveBrowserOpenCommand()).resolves.toEqual({
      argv: null,
      reason: "no-display",
    });
    await expect(resolveBrowserOpenCommand()).resolves.toEqual({
      argv: null,
      reason: "no-display",
    });

    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("reports display-less WSL support only when wslview is installed", async () => {
    detectBinaryMock.mockImplementation(async (binary) => binary === "wslview");

    await expect(
      detectBrowserOpenSupport({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      }),
    ).resolves.toEqual({ ok: true, command: "wslview" });

    detectBinaryMock.mockResolvedValue(false);
    await expect(
      detectBrowserOpenSupport({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      }),
    ).resolves.toEqual({ ok: false, reason: "wsl-no-wslview" });
  });

  it("prefers the registry-backed Windows system root over process env", async () => {
    vi.resetModules();
    const { resolveBrowserOpenCommand: resolveCommand } = await import("./browser-open.js");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation((_file: string, args: readonly string[]) =>
      args[3] === "SystemRoot" ? "SystemRoot    REG_SZ    D:\\Windows\r\n" : "",
    );
    mockProcessPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");

    const resolved = await resolveCommand();

    const rundll32 = path.win32.join("D:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("resolves macOS open even when SSH environment variables are present", async () => {
    mockProcessPlatform("darwin");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
    detectBinaryMock.mockResolvedValueOnce(true);

    const resolved = await resolveBrowserOpenCommand();

    expect(detectBinaryMock).toHaveBeenCalledWith("open");
    expect(resolved).toEqual({ argv: ["open"], command: "open" });
  });

  it("still refuses browser launch over Linux SSH without a display", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");

    const resolved = await resolveBrowserOpenCommand();

    expect(resolved).toEqual({ argv: null, reason: "ssh-no-display" });
  });

  it("resolves xdg-open over Linux SSH with a forwarded display", async () => {
    detectBinaryMock.mockImplementation(async (binary) => binary === "xdg-open");

    const resolved = await resolveBrowserOpenCommand({
      platform: "linux",
      env: {
        DISPLAY: "localhost:10.0",
        SSH_CONNECTION: "192.0.2.1 12345 192.0.2.2 22",
      },
    });

    expect(resolved).toEqual({ argv: ["xdg-open"], command: "xdg-open" });
  });
});
