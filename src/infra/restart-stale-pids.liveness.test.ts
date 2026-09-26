import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockIsPidAlive = vi.hoisted(() => vi.fn());
const mockReadGatewayOwnerLease = vi.hoisted(() => vi.fn());
const observedArgv = vi.hoisted(() => new Map<number, string[]>());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawnSync: (...args: unknown[]) => mockSpawnSync(...args) },
  );
});

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readFileSync: ((...args: unknown[]) =>
        mockReadFileSync(...args)) as typeof actual.readFileSync,
    }),
    { mirrorToDefault: true },
  );
});

vi.mock("../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../shared/pid-alive.js")>()),
  isPidAlive: mockIsPidAlive,
}));

vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: (pid: number) => {
    const argv = observedArgv.get(pid);
    return argv ? { argv } : undefined;
  },
}));

vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: mockReadGatewayOwnerLease,
}));

vi.mock("./ports-lsof.js", () => ({ resolveLsofCommandSync: () => "lsof" }));

let cleanStaleGatewayProcessesSync: typeof import("./restart-stale-pids.js").cleanStaleGatewayProcessesSync;

describe.skipIf(process.platform === "win32")("stale PID liveness", () => {
  beforeAll(async () => {
    ({ cleanStaleGatewayProcessesSync } = await import("./restart-stale-pids.js"));
  });

  beforeEach(() => {
    mockReadGatewayOwnerLease.mockReturnValue(undefined);
    mockIsPidAlive.mockReturnValue(false);
    observedArgv.clear();
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(filePath))?.[1]);
      const argv = observedArgv.get(pid);
      if (argv) {
        return argv.join("\0");
      }
      throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
    });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSpawnSync.mockReset();
    mockReadFileSync.mockReset();
    mockIsPidAlive.mockReset();
    mockReadGatewayOwnerLease.mockReset();
  });

  it("does not force-kill a stale PID that canonical liveness reports dead", () => {
    const stalePid = process.pid + 499;
    observedArgv.set(stalePid, ["openclaw-gateway"]);
    mockSpawnSync
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: `p${stalePid}\ncopenclaw-gateway\n`,
        stderr: "",
      })
      .mockReturnValue({ error: null, status: 1, stdout: "", stderr: "" });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toStrictEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("treats lsof exit status 1 as port-free", () => {
    const stalePid = process.pid + 500;
    observedArgv.set(stalePid, ["openclaw-gateway"]);
    mockIsPidAlive.mockReturnValue(true);
    mockSpawnSync
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: `p${stalePid}\ncopenclaw-gateway\n`,
        stderr: "",
      })
      .mockReturnValue({ error: null, status: 1, stdout: "", stderr: "" });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toStrictEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
  });
});
