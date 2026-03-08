import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const readFileSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
  },
}));

const { isWSLEnv, isWSLSync, isWSL2Sync, isWSL, resetWSLStateForTests } = await import("./wsl.js");

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("wsl detection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV"]);
    readFileSyncMock.mockReset();
    readFileMock.mockReset();
    resetWSLStateForTests();
    setPlatform("linux");
  });

  afterEach(() => {
    envSnapshot.restore();
    resetWSLStateForTests();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it.each([
    ["WSL_DISTRO_NAME", "Ubuntu"],
    ["WSL_INTEROP", "/run/WSL/123_interop"],
    ["WSLENV", "PATH/l"],
  ])("detects WSL from %s", (key, value) => {
    process.env[key] = value;
    expect(isWSLEnv()).toBe(true);
  });

  it("reads /proc/version for sync WSL detection when env vars are absent", () => {
    readFileSyncMock.mockReturnValueOnce("Linux version 6.6.0-1-microsoft-standard-WSL2");
    expect(isWSLSync()).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/version", "utf8");
  });

  it.each(["Linux version 6.6.0-1-microsoft-standard-WSL2", "Linux version 6.6.0-1-wsl2"])(
    "detects WSL2 sync from kernel version: %s",
    (kernelVersion) => {
      readFileSyncMock.mockReturnValueOnce(kernelVersion);
      readFileSyncMock.mockReturnValueOnce(kernelVersion);
      expect(isWSL2Sync()).toBe(true);
    },
  );

  it("returns false for sync detection on non-linux platforms", () => {
    setPlatform("darwin");
    expect(isWSLSync()).toBe(false);
    expect(isWSL2Sync()).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("caches async WSL detection until reset", async () => {
    readFileMock.mockResolvedValue("6.6.0-1-microsoft-standard-WSL2");

    await expect(isWSL()).resolves.toBe(true);
    await expect(isWSL()).resolves.toBe(true);

    expect(readFileMock).toHaveBeenCalledTimes(1);

    resetWSLStateForTests();
    await expect(isWSL()).resolves.toBe(true);
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it("returns false when async WSL detection cannot read osrelease", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(isWSL()).resolves.toBe(false);
  });

  it("returns false for async detection on non-linux platforms without reading osrelease", async () => {
    setPlatform("win32");
    await expect(isWSL()).resolves.toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
