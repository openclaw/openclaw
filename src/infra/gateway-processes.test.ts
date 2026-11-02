import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { getWindowsPowerShellExePath, getWindowsSystem32ExePath } from "./windows-install-roots.js";

const spawn = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => vi.fn());
const readOwner = vi.hoisted(() =>
  vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
);

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawn, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    { readFileSync: (...args: unknown[]) => readFile(...args) },
    { mirrorToDefault: true },
  );
});

// mock-isolation: Inject listener census results without probing live host processes.
vi.mock("./restart-stale-pids.js", () => ({
  findGatewayPidsOnPortSync: (...args: unknown[]) => listeners(...args),
}));

// mock-isolation: Inject lease ownership without reading host lease files.
vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: readOwner,
}));

// mock-isolation: Keep synthetic process-safety cases independent of global logger state.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ debug: vi.fn() })),
}));

const { findVerifiedGatewayListenerPidsOnPortSync: find, signalVerifiedGatewayPidSync: signal } =
  await import("./gateway-processes.js");

const output = (stdout: string) => ({ error: null, status: 0, stdout });
const spyOnKill = () => vi.spyOn(process, "kill").mockImplementation(() => true);
function expectRefused(killSpy: ReturnType<typeof spyOnKill>) {
  expect(() => signal(500, "SIGTERM", { port: 18789 })).toThrow(
    "refusing to signal non-gateway process pid 500",
  );
  expect(killSpy).not.toHaveBeenCalled();
}

function mockRelativeWindowsGateway(pids = [500]) {
  mockProcessPlatform("win32");
  spawn.mockImplementation((_command: string, args: string[]) => ({
    error: null,
    status: 0,
    stdout: args.at(-1)?.includes("Get-NetTCPConnection")
      ? pids.join("\r\n")
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
  beforeEach(() => [spawn, readFile, listeners, readOwner].forEach((mock) => mock.mockReset()));

  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, "ESRCH", "EPERM"] as const)(
    "signals only verified gateways and handles kill error %s",
    (code) => {
      mockProcessPlatform("linux");
      readFile.mockReturnValue("openclaw-gateway\0");
      const error = Object.assign(new Error("permission denied"), { code });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        if (code) {
          throw error;
        }
        return true;
      });
      const send = () => signal(500, "SIGTERM");
      if (code === "EPERM") {
        expect(send).toThrow(error);
      } else {
        expect(send).not.toThrow();
      }
      expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
      if (!code) {
        readFile.mockReturnValue("python\0");
        expect(() => signal(501, "SIGUSR1")).toThrow(
          /refusing to signal non-gateway process pid 501/,
        );
      }
    },
  );

  it("dedupes and filters verified gateway listener pids on unix and windows", () => {
    mockProcessPlatform("linux");
    listeners.mockReturnValue([process.pid, 200, 200, 300, -1]);
    readFile.mockReturnValueOnce("openclaw-gateway\0gateway\0");
    readFile.mockReturnValueOnce("python\0-m\0http.server\0");

    expect(find(18789)).toEqual([200]);
    mockProcessPlatform("win32");
    spawn
      .mockReturnValueOnce(output("200\r\n200\r\n0\r\n"))
      .mockReturnValueOnce(output("openclaw-gateway"));

    expect(find(18789)).toEqual([200]);
  });

  it("falls back from powershell to trusted netstat for windows listener pids", () => {
    mockProcessPlatform("win32");
    spawn
      .mockReturnValueOnce({ error: new Error("powershell missing"), status: null, stdout: "" })
      .mockReturnValueOnce(
        output(
          [
            "Proto  Local Address          Foreign Address        State           PID",
            "TCP    127.0.0.1:18789       127.0.0.1:0            ABHOEREN       998",
            "TCP    127.0.0.1:18789       127.0.0.1:54321        HERGESTELLT    999",
            "TCP    0.0.0.0:18789         0.0.0.0:0              ABHOEREN       200",
            "TCP    [::]:18789            [::]:0                 ABHOEREN       200",
          ].join("\r\n"),
        ),
      )
      .mockReturnValueOnce(output("openclaw-gateway"));

    expect(find(18789)).toEqual([200]);
    expect(spawn.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
    expect(spawn.mock.calls[1]?.[0]).toBe(getWindowsSystem32ExePath("netstat.exe"));
    expect(spawn.mock.calls[1]?.[1]).toEqual(["-ano"]);
    expect(spawn.mock.calls[2]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("recognizes a relative Windows gateway only at its recorded listener PID and port", () => {
    mockRelativeWindowsGateway([500, 600, 500]);
    readOwner.mockReturnValue(gatewayOwner());
    const env = { OPENCLAW_STATE_DIR: "C:\\fixture\\state" };
    const killSpy = spyOnKill();

    expect(find(18789, { env })).toEqual([500]);
    signal(500, "SIGTERM", { env, port: 18789 });
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
    expect(readOwner).toHaveBeenCalledWith({ env, port: 18789, current: true });
    expect(find(18890, { env })).toEqual([]);
    mockRelativeWindowsGateway([600]);
    expect(find(18789, { env })).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["unreadable", undefined],
    ["reused PID", gatewayOwner({ state: "dead" })],
    ["unverified creation time", gatewayOwner({ state: "unknown", startedAt: null })],
    ["foreign host", gatewayOwner({ state: "unknown", host: "other-host" })],
    ["different PID", gatewayOwner({ pid: 501 })],
    ["different port", gatewayOwner({ port: 18890 })],
  ] as const)("refuses Windows discovery and signaling with a %s owner", (label, owner) => {
    mockRelativeWindowsGateway();
    if (label === "unreadable") {
      readOwner.mockImplementation(() => {
        throw new Error("database unavailable");
      });
    } else {
      readOwner.mockReturnValue(owner);
    }
    const killSpy = spyOnKill();

    expect(find(18789)).toEqual([]);
    expectRefused(killSpy);
  });

  it("refuses a Windows owner lost between listener discovery and signaling", () => {
    mockRelativeWindowsGateway();
    readOwner.mockReturnValueOnce(gatewayOwner()).mockReturnValueOnce(undefined);
    const killSpy = spyOnKill();

    expect(find(18789)).toEqual([500]);
    expectRefused(killSpy);
  });
});
