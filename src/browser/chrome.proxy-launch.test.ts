import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("node:fs", () => {
  const existsSync = vi.fn(() => true);
  const mkdirSync = vi.fn();
  return {
    existsSync,
    mkdirSync,
    default: { existsSync, mkdirSync },
  };
});

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: vi.fn(async () => {}),
}));

vi.mock("./chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: vi.fn(() => ({
    kind: "chrome",
    path: "/tmp/fake-chrome",
  })),
}));

vi.mock("./chrome.profile-decoration.js", () => ({
  decorateOpenClawProfile: vi.fn(),
  ensureProfileCleanExit: vi.fn(),
  isProfileDecorated: vi.fn(() => true),
}));

vi.mock("./cdp.js", () => ({
  getHeadersWithAuth: vi.fn(() => ({})),
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
}));

import { spawn } from "node:child_process";
import { launchOpenClawChrome } from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

type MockProc = {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(): MockProc {
  return {
    pid: 4321,
    killed: false,
    exitCode: null,
    kill: vi.fn(),
  };
}

describe("browser chrome proxy launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as unknown as Response),
    );
    vi.mocked(spawn).mockImplementation(() => createMockProc() as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes profile proxy via --proxy-server (profile overrides global)", async () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://global-proxy:8080",
      profiles: {
        work: {
          cdpPort: 18801,
          color: "#0066CC",
          proxy: "http://profile-proxy:9090",
        },
      },
    });
    const profile = resolveProfile(resolved, "work");
    expect(profile).not.toBeNull();

    await launchOpenClawChrome(resolved, profile!);

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args).toBeDefined();
    expect(args).toContain("--proxy-server=http://profile-proxy:9090");
    expect(args).not.toContain("--proxy-server=http://global-proxy:8080");
  });

  it("passes sanitized proxy URL without credentials to --proxy-server", async () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://username:p%40ss@proxy.example.com:8080",
    });
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).not.toBeNull();

    // Keep this launch test focused on arg injection; auth wiring is covered elsewhere.
    const profileWithoutAuth = {
      ...profile!,
      proxyCredentials: undefined,
    };

    await launchOpenClawChrome(resolved, profileWithoutAuth);

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args).toBeDefined();
    expect(args).toContain("--proxy-server=http://proxy.example.com:8080");
    const argLine = args?.join(" ") ?? "";
    expect(argLine).not.toContain("username");
    expect(argLine).not.toContain("p@ss");
  });
});
