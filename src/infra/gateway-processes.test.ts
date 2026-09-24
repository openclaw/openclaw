// Covers gateway process discovery across platform process listings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.js";
import { getWindowsPowerShellExePath, getWindowsSystem32ExePath } from "./windows-install-roots.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const findGatewayPidsOnPortSyncMock = vi.hoisted(() => vi.fn());
const readGatewayOwnerLeaseMock = vi.hoisted(() =>
  vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
);

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

vi.mock("./restart-stale-pids.js", () => ({
  findGatewayPidsOnPortSync: (...args: unknown[]) => findGatewayPidsOnPortSyncMock(...args),
}));

vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: readGatewayOwnerLeaseMock,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
    isEnabled: vi.fn(() => false),
    subsystem: "test",
  })),
}));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: vi.fn(() => []),
  getChatChannelMeta: vi.fn(() => null),
}));

const {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} = await import("./gateway-processes.js");

function mockRelativeWindowsGateway(listeners = [500]) {
  mockProcessPlatform("win32");
  spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
    error: null,
    status: 0,
    stdout: args.at(-1)?.includes("Get-NetTCPConnection")
      ? listeners.join("\r\n")
      : "node.exe dist/index.js gateway --port 18789",
  }));
}

function gatewayOwner(
  overrides: Partial<GatewayOwnerLeaseIdentity> = {},
): GatewayOwnerLeaseIdentity {
  return {
    owner: "gateway-generation",
    pid: 500,
    host: "fixture-host",
    startedAt: 123,
    port: 18789,
    mode: "foreground",
    supervisor: null,
    state: "live",
    expired: false,
    ...overrides,
  };
}

describe("gateway-processes", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    readFileSyncMock.mockReset();
    findGatewayPidsOnPortSyncMock.mockReset();
    readGatewayOwnerLeaseMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signals only verified gateway processes", () => {
    mockProcessPlatform("linux");
    readFileSyncMock.mockReturnValue("openclaw-gateway\0");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    signalVerifiedGatewayPidSync(500, "SIGTERM");
    readFileSyncMock.mockReturnValue("python\0");
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");

    expect(() => signalVerifiedGatewayPidSync(501, "SIGUSR1")).toThrow(
      /refusing to signal non-gateway process pid 501/,
    );
  });

  it("swallows ESRCH when a verified gateway process exits before the signal", () => {
    mockProcessPlatform("linux");
    readFileSyncMock.mockReturnValue("openclaw-gateway\0");
    const esrchErr = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw esrchErr;
    });

    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM")).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
  });

  it("re-throws non-ESRCH kill errors", () => {
    mockProcessPlatform("linux");
    readFileSyncMock.mockReturnValue("openclaw-gateway\0");
    const epermErr = Object.assign(new Error("permission denied"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });

    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM")).toThrow("permission denied");
  });

  it("dedupes and filters verified gateway listener pids on unix and windows", () => {
    mockProcessPlatform("linux");
    findGatewayPidsOnPortSyncMock.mockReturnValue([process.pid, 200, 200, 300, -1]);
    readFileSyncMock.mockReturnValueOnce("openclaw-gateway\0gateway\0");
    readFileSyncMock.mockReturnValueOnce("python\0-m\0http.server\0");

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
    mockProcessPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "200\r\n200\r\n0\r\n",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "openclaw-gateway",
      });

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
  });

  it("falls back from powershell to trusted netstat for windows listener pids", () => {
    mockProcessPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("powershell missing"),
        status: null,
        stdout: "",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: [
          "Proto  Local Address          Foreign Address        State           PID",
          "TCP    127.0.0.1:18789       127.0.0.1:0            ABHOEREN       998",
          "TCP    127.0.0.1:18789       127.0.0.1:54321        HERGESTELLT    999",
          "TCP    0.0.0.0:18789         0.0.0.0:0              ABHOEREN       200",
          "TCP    [::]:18789            [::]:0                 ABHOEREN       200",
        ].join("\r\n"),
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "openclaw-gateway",
      });

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsSystem32ExePath("netstat.exe"));
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual(["-ano"]);
    expect(spawnSyncMock.mock.calls[2]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("formats pid lists as comma-separated output", () => {
    expect(formatGatewayPidList([1, 2, 3])).toBe("1, 2, 3");
  });

  it("recognizes a relative Windows gateway only at its recorded listener PID and port", () => {
    mockRelativeWindowsGateway([500, 600, 500]);
    readGatewayOwnerLeaseMock.mockReturnValue(gatewayOwner());
    const env = { OPENCLAW_STATE_DIR: "C:\\fixture\\state" };

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789, { env })).toEqual([500]);
    expect(readGatewayOwnerLeaseMock).toHaveBeenCalledWith({ env, port: 18789, current: true });
    expect(findVerifiedGatewayListenerPidsOnPortSync(18890, { env })).toEqual([]);
    mockRelativeWindowsGateway([600]);
    expect(findVerifiedGatewayListenerPidsOnPortSync(18789, { env })).toEqual([]);
  });

  it("signals a relative Windows gateway using freshly verified recorded ownership", () => {
    mockRelativeWindowsGateway();
    readGatewayOwnerLeaseMock.mockReturnValue(gatewayOwner());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const env = { OPENCLAW_STATE_DIR: "C:\\fixture\\state" };

    signalVerifiedGatewayPidSync(500, "SIGTERM", { env, port: 18789 });
    expect(readGatewayOwnerLeaseMock).toHaveBeenCalledWith({ env, port: 18789, current: true });
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
  });

  it.each([
    ["missing", undefined],
    ["reused PID", gatewayOwner({ state: "dead" })],
    ["unverified creation time", gatewayOwner({ state: "unknown", startedAt: null })],
    ["foreign host", gatewayOwner({ state: "unknown", host: "other-host" })],
    ["different PID", gatewayOwner({ pid: 501 })],
    ["different port", gatewayOwner({ port: 18890 })],
  ] as const)("refuses Windows discovery and signaling with a %s owner", (_label, owner) => {
    mockRelativeWindowsGateway();
    readGatewayOwnerLeaseMock.mockReturnValue(owner);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([]);
    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM", { port: 18789 })).toThrow(
      "refusing to signal non-gateway process pid 500",
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("refuses a Windows owner lost between listener discovery and signaling", () => {
    mockRelativeWindowsGateway();
    readGatewayOwnerLeaseMock.mockReturnValueOnce(gatewayOwner()).mockReturnValueOnce(undefined);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([500]);
    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM", { port: 18789 })).toThrow(
      "refusing to signal non-gateway process pid 500",
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does not signal when the Windows owner lease cannot be read", () => {
    mockRelativeWindowsGateway();
    readGatewayOwnerLeaseMock.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM")).toThrow(
      "refusing to signal non-gateway process pid 500",
    );
    expect(killSpy).not.toHaveBeenCalled();
  });
});
