import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const detectBinaryMock = vi.hoisted(() => vi.fn(async () => true));
const isWSLMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

vi.mock("./detect-binary.js", () => ({
  detectBinary: detectBinaryMock,
}));

vi.mock("./wsl.js", () => ({
  isWSL: isWSLMock,
}));

const { openUrl, openUrlInBackground, resolveBrowserOpenCommand } = await import("./browser-open.js");

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  detectBinaryMock.mockReset();
  detectBinaryMock.mockResolvedValue(true);
  isWSLMock.mockReset();
  isWSLMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveBrowserOpenCommand", () => {
  it("uses explorer.exe on win32", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const resolved = await resolveBrowserOpenCommand();
      expect(resolved.argv).toEqual(["explorer.exe"]);
      expect(resolved.command).toBe("explorer.exe");
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("openUrl", () => {
  it("passes safe Windows URLs to explorer.exe without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const url = "https://example.invalid/oauth?code=abc#state=123";

    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    try {
      await expect(openUrl(url)).resolves.toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["explorer.exe", url], {
        timeoutMs: 5_000,
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("rejects provider-supplied Windows URLs with embedded quotes", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expect(openUrl('https://example.invalid/" & calc & rem "')).resolves.toBe(false);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("rejects non-http browser URLs", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expect(openUrl("javascript:alert(1)")).resolves.toBe(false);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("openUrlInBackground", () => {
  it("rejects quoted URLs before invoking open", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    try {
      await expect(openUrlInBackground('https://example.invalid/"bad"')).resolves.toBe(false);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });
});
