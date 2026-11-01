// Covers WSL detection from platform and release files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const readFileSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: readFileSyncMock,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      readFile: readFileMock,
    },
    readFile: readFileMock,
  };
});

let isWSL2Sync: typeof import("./wsl.js").isWSL2Sync;
let isWSL: typeof import("./wsl.js").isWSL;

describe("wsl detection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    vi.resetModules();
    ({ isWSL2Sync, isWSL } = await import("./wsl.js"));
    envSnapshot = captureEnv(["WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV"]);
    deleteTestEnvValue("WSL_INTEROP");
    deleteTestEnvValue("WSL_DISTRO_NAME");
    deleteTestEnvValue("WSLENV");
    readFileSyncMock.mockReset();
    readFileMock.mockReset();
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("returns false when sync detection cannot read /proc/version", () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(isWSL2Sync()).toBe(false);
  });

  it("returns false for WSL2 sync when WSL is detected but no WSL2 markers exist", () => {
    readFileSyncMock.mockReturnValueOnce("Linux version 4.4.0-19041-Microsoft");
    readFileSyncMock.mockReturnValueOnce("Linux version 4.4.0-19041-Microsoft");
    expect(isWSL2Sync()).toBe(false);
  });

  it("returns false for sync detection on non-linux platforms", () => {
    mockProcessPlatform("darwin");
    expect(isWSL2Sync()).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("caches async WSL detection for the module lifetime", async () => {
    readFileMock.mockResolvedValue("6.6.0-1-microsoft-standard-WSL2");

    await expect(isWSL()).resolves.toBe(true);
    await expect(isWSL()).resolves.toBe(true);

    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when async WSL detection cannot read osrelease", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(isWSL()).resolves.toBe(false);
  });
});
