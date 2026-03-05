import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserConfig } from "./config.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("node:fs", () => {
  const existsSync = vi.fn(() => true);
  const mkdirSync = vi.fn();
  return { existsSync, mkdirSync, default: { existsSync, mkdirSync } };
});

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: vi.fn(async () => {}),
}));

vi.mock("./chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: vi.fn(() => ({
    kind: "chromium",
    path: "/usr/bin/chromium",
  })),
}));

vi.mock("./chrome.profile-decoration.js", () => ({
  decorateOpenClawProfile: vi.fn(),
  ensureProfileCleanExit: vi.fn(),
  isProfileDecorated: vi.fn(() => false),
}));

vi.mock("./cdp.helpers.js", () => ({
  appendCdpPath: (url: string) => `${url}/json/version`,
  fetchCdpChecked: async () => ({
    json: async () => ({ Browser: "Chrome" }),
  }),
  openCdpWebSocket: vi.fn(),
}));

import { launchOpenClawChrome } from "./chrome.js";

type MockChildProcess = {
  pid: number;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
};

function createMockChromeProcess() {
  const child = {
    pid: 1234,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
  } as MockChildProcess;
  return child;
}

function makeResolvedConfig(): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: false,
    controlPort: 18791,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18810,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: "#00AA00",
    executablePath: "/usr/bin/chromium",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    defaultProfile: "openclaw",
    profiles: {},
    extraArgs: [],
  };
}

function makeProfile() {
  return {
    name: "openclaw",
    cdpPort: 18800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#00AA00",
    driver: "openclaw" as const,
    attachOnly: false,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => createMockChromeProcess());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("launchOpenClawChrome", () => {
  it("adds certificate-related flags when dangerous private-network policy is enabled", async () => {
    const resolved = makeResolvedConfig();
    resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: true };

    await launchOpenClawChrome(resolved, makeProfile());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--ignore-certificate-errors");
    expect(args).toContain("--allow-insecure-localhost");
  });

  it("omits certificate-related flags when dangerous private-network policy is disabled", async () => {
    const resolved = makeResolvedConfig();

    await launchOpenClawChrome(resolved, makeProfile());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--ignore-certificate-errors");
    expect(args).not.toContain("--allow-insecure-localhost");
  });

  it("adds --disable-setuid-sandbox when noSandbox is true", async () => {
    const resolved = makeResolvedConfig();
    resolved.noSandbox = true;

    await launchOpenClawChrome(resolved, makeProfile());

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--disable-setuid-sandbox");
    expect(args).toContain("--no-sandbox");
  });
});
