// Covers WSL detection from platform and kernel metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const readFileSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const versionMock = vi.hoisted(() => vi.fn());

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

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: releaseMock,
  version: versionMock,
}));

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
    releaseMock.mockReset().mockReturnValue("6.6.0-generic");
    versionMock.mockReset().mockReturnValue("#1 SMP");
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("returns false when sync kernel metadata is unavailable", () => {
    versionMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(isWSL2Sync()).toBe(false);
  });

  it("returns false for WSL2 sync when WSL is detected but no WSL2 markers exist", () => {
    releaseMock.mockReturnValue("4.4.0-19041-Microsoft");
    expect(isWSL2Sync()).toBe(false);
  });

  it.each([
    ["6.6.0-WSL2", "#1 SMP", true],
    ["6.6.0-microsoft-standard", "#1 SMP", true],
    ["6.6.0", "#1 SMP WSL2", true],
    ["6.6.0-generic", "#1 SMP", false],
  ] as const)("detects WSL2 without filesystem reads (%s, %s)", (release, version, detected) => {
    releaseMock.mockReturnValue(release);
    versionMock.mockReturnValue(version);
    readFileSyncMock.mockReturnValue(`Linux version ${release} ${version}`);
    expect(isWSL2Sync()).toBe(detected);
    expect(isWSL2Sync()).toBe(detected);
    expect(readFileSyncMock).not.toHaveBeenCalled();
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
