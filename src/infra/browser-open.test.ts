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
    readFileMock: vi.fn<() => Promise<string>>(),
    runCommandWithTimeoutMock: vi.fn<
      (argv: string[], optionsOrTimeout?: number | { timeoutMs?: number }) => Promise<SpawnResult>
    >(async () => ({
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
let openLocalFile: typeof import("./browser-open.js").openLocalFile;

beforeEach(async () => {
  vi.resetModules();
  ({ detectBrowserOpenSupport, openUrl, openLocalFile } = await import("./browser-open.js"));
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DISPLAY", "");
  vi.stubEnv("WAYLAND_DISPLAY", "");
  vi.stubEnv("WSL_INTEROP", "");
  vi.stubEnv("WSL_DISTRO_NAME", "");
  vi.stubEnv("WSLENV", "");
  vi.stubEnv("SSH_CLIENT", "");
  vi.stubEnv("SSH_CONNECTION", "");
  vi.stubEnv("SSH_TTY", "");
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

    await expect(openUrl("https://example.com/")).resolves.toBe(true);
  });
});

describe("openLocalFile", () => {
  it("passes only the private file:// path to the opener, never a credential URL", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DISPLAY", ":0");
    detectBinaryMock.mockResolvedValue(true);
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(openLocalFile("/tmp/openclaw-browser-handoff-X/handoff.html")).resolves.toBe(true);
    const argv = runCommandWithTimeoutMock.mock.calls[0]![0];
    expect(argv[0]).toBe("xdg-open");
    expect(argv).toHaveLength(2);
    expect(argv[1]).toMatch(/^file:\/\//);
    expect(argv[1]).not.toContain("bootstrapToken");
  });

  it("opens native Windows handoff paths instead of reading the drive letter as a URL scheme", async () => {
    mockProcessPlatform("win32");

    await expect(
      openLocalFile(
        "C:\\Users\\Alice\\AppData\\Local\\Temp\\openclaw-browser-handoff-ABC123\\handoff.html",
      ),
    ).resolves.toBe(true);
    const argv = runCommandWithTimeoutMock.mock.calls[0]![0];
    expect(argv.at(-2)).toBe("url.dll,FileProtocolHandler");
    expect(argv.at(-1)).toBe(
      "file:///C:/Users/Alice/AppData/Local/Temp/openclaw-browser-handoff-ABC123/handoff.html",
    );
  });

  it("refuses http(s) URLs and non-file inputs", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await expect(openLocalFile("http://127.0.0.1:18789/#bootstrapToken=x")).resolves.toBe(false);
    await expect(openLocalFile("file:///tmp/handoff.html")).resolves.toBe(false);
    await expect(openLocalFile("relative/handoff.html")).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe("browser support and launch", () => {
  it("retains process-level WSL detection caching through support detection", async () => {
    mockProcessPlatform("linux");

    await expect(detectBrowserOpenSupport()).resolves.toEqual({
      ok: false,
      reason: "no-display",
    });
    await expect(detectBrowserOpenSupport()).resolves.toEqual({
      ok: false,
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
    ).resolves.toEqual({ ok: true });

    mockProcessPlatform("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    await expect(openUrl("https://example.com/")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledExactlyOnceWith(
      ["wslview", "https://example.com/"],
      { timeoutMs: 5_000 },
    );

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
    const { openUrl: openBrowser } = await import("./browser-open.js");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation((_file: string, args: readonly string[]) =>
      args[3] === "SystemRoot" ? "SystemRoot    REG_SZ    D:\\Windows\r\n" : "",
    );
    mockProcessPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");

    await expect(openBrowser("https://example.com/")).resolves.toBe(true);

    const rundll32 = path.win32.join("D:\\Windows", "System32", "rundll32.exe");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledExactlyOnceWith(
      [rundll32, "url.dll,FileProtocolHandler", "https://example.com/"],
      { timeoutMs: 5_000 },
    );
  });

  it("resolves macOS open even when SSH environment variables are present", async () => {
    mockProcessPlatform("darwin");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
    detectBinaryMock.mockResolvedValueOnce(true);

    await expect(openUrl("https://example.com/")).resolves.toBe(true);

    expect(detectBinaryMock).toHaveBeenCalledWith("open");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledExactlyOnceWith(
      ["open", "https://example.com/"],
      { timeoutMs: 5_000 },
    );
  });

  it("still refuses browser launch over Linux SSH without a display", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");

    await expect(detectBrowserOpenSupport()).resolves.toEqual({
      ok: false,
      reason: "ssh-no-display",
    });
    await expect(openUrl("https://example.com/")).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("resolves xdg-open over Linux SSH with a forwarded display", async () => {
    detectBinaryMock.mockImplementation(async (binary) => binary === "xdg-open");
    mockProcessPlatform("linux");
    vi.stubEnv("DISPLAY", "localhost:10.0");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");

    await expect(openUrl("https://example.com/")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledExactlyOnceWith(
      ["xdg-open", "https://example.com/"],
      { timeoutMs: 5_000 },
    );
  });
});
