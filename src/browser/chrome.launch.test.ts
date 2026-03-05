import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const resolveBrowserExecutableForPlatformMock = vi.hoisted(() => vi.fn());
const isProfileDecoratedMock = vi.hoisted(() => vi.fn());
const ensureProfileCleanExitMock = vi.hoisted(() => vi.fn());
const decorateOpenClawProfileMock = vi.hoisted(() => vi.fn());
const ensurePortAvailableMock = vi.hoisted(() => vi.fn());
const fetchCdpCheckedMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: (...args: unknown[]) => ensurePortAvailableMock(...args),
}));

vi.mock("./chrome.executables.js", () => ({
  findChromeExecutableLinux: vi.fn(),
  findChromeExecutableMac: vi.fn(),
  findChromeExecutableWindows: vi.fn(),
  resolveBrowserExecutableForPlatform: (...args: unknown[]) =>
    resolveBrowserExecutableForPlatformMock(...args),
}));

vi.mock("./chrome.profile-decoration.js", () => ({
  isProfileDecorated: (...args: unknown[]) => isProfileDecoratedMock(...args),
  ensureProfileCleanExit: (...args: unknown[]) => ensureProfileCleanExitMock(...args),
  decorateOpenClawProfile: (...args: unknown[]) => decorateOpenClawProfileMock(...args),
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdp.helpers.js")>();
  return {
    ...actual,
    fetchCdpChecked: (...args: unknown[]) => fetchCdpCheckedMock(...args),
  };
});

vi.mock("node:fs", () => {
  return {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    default: {
      existsSync: (...args: unknown[]) => existsSyncMock(...args),
      mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    },
  };
});

import { launchOpenClawChrome } from "./chrome.js";

beforeEach(() => {
  vi.clearAllMocks();
  resolveBrowserExecutableForPlatformMock.mockReturnValue({
    path: "/opt/google/chrome",
    kind: "chrome",
  });
  isProfileDecoratedMock.mockReturnValue(true);
  ensurePortAvailableMock.mockResolvedValue(undefined);
  mkdirSyncMock.mockReturnValue(undefined);
  existsSyncMock.mockImplementation((target: unknown) => {
    const filePath = String(target);
    return filePath.includes("Local State") || filePath.includes("Preferences");
  });
  decorateOpenClawProfileMock.mockReturnValue(undefined);
  ensureProfileCleanExitMock.mockReturnValue(undefined);
  fetchCdpCheckedMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ Browser: "OpenClaw", "User-Agent": "chrome" }), { status: 200 }),
    ),
  );
  spawnMock.mockReturnValue({
    pid: 9001,
    stderr: {
      on: vi.fn(),
      off: vi.fn(),
    },
    kill: vi.fn(),
    exitCode: null,
  });
});

describe("launchOpenClawChrome", () => {
  it("does not include removed Blink automation flag", async () => {
    const profile = {
      name: "default",
      cdpPort: 9222,
      cdpUrl: "http://127.0.0.1:9222",
      cdpIsLoopback: true,
      color: "teal",
    } as const;

    const resolved = {
      extraArgs: [],
      noSandbox: false,
      headless: false,
    } as const;

    await launchOpenClawChrome(resolved, profile as unknown as Parameters<typeof launchOpenClawChrome>[1]);

    const args = spawnMock.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
  });
});
