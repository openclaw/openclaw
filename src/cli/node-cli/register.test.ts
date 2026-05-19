import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodeCli } from "./register.js";

type MockNodeHostConfig = {
  version: 1;
  nodeId: string;
  gateway?: {
    host?: string;
    port?: number;
  };
};

const daemonMocks = vi.hoisted(() => ({
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonRestart: vi.fn(),
  runNodeDaemonStart: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
  runNodeDaemonStop: vi.fn(),
  runNodeDaemonUninstall: vi.fn(),
}));

vi.mock("./daemon.js", () => daemonMocks);

const loadNodeHostConfigMock = vi.hoisted(() =>
  vi.fn<() => Promise<MockNodeHostConfig | null>>(async () => null),
);
vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: loadNodeHostConfigMock,
}));

const runNodeHostMock = vi.hoisted(() => vi.fn());
vi.mock("../../node-host/runner.js", () => ({
  runNodeHost: runNodeHostMock,
}));

const runtimeMocks = vi.hoisted(() => ({
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("__exit__");
  }),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerNodeCli(program);
  return program;
}

describe("registerNodeCli", () => {
  beforeEach(() => {
    runNodeHostMock.mockReset();
    runtimeMocks.error.mockReset();
    runtimeMocks.exit.mockClear();
    runtimeMocks.exit.mockImplementation(() => {
      throw new Error("__exit__");
    });
    loadNodeHostConfigMock.mockReset();
    loadNodeHostConfigMock.mockImplementation(async () => null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers node start for the macOS app node service manager", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "start", "--json"], { from: "user" });

    expect(daemonMocks.runNodeDaemonStart.mock.calls[0]?.[0]?.json).toBe(true);
  });

  // #83923: `node run --port <bad>` previously silently fell back to the
  // configured / default port. Now it must surface an invalid-option error
  // and exit before reaching runNodeHost.
  it("fails fast on non-numeric --port for node run (#83923)", async () => {
    const program = createProgram();
    await expect(
      program.parseAsync(["node", "run", "--port", "abc"], { from: "user" }),
    ).rejects.toThrow("__exit__");

    expect(runtimeMocks.error).toHaveBeenCalledTimes(1);
    expect(String(runtimeMocks.error.mock.calls[0]?.[0])).toMatch(/--port/i);
    expect(runtimeMocks.exit).toHaveBeenCalledWith(1);
    expect(runNodeHostMock).not.toHaveBeenCalled();
  });

  it("fails fast on out-of-range --port for node run (#83923)", async () => {
    const program = createProgram();
    await expect(
      program.parseAsync(["node", "run", "--port", "99999"], { from: "user" }),
    ).rejects.toThrow("__exit__");

    expect(runtimeMocks.error).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.exit).toHaveBeenCalledWith(1);
    expect(runNodeHostMock).not.toHaveBeenCalled();
  });

  it("passes a valid --port through to runNodeHost (#83923 no-regression)", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "run", "--port", "8123"], { from: "user" });

    expect(runtimeMocks.exit).not.toHaveBeenCalled();
    expect(runNodeHostMock).toHaveBeenCalledTimes(1);
    expect(runNodeHostMock.mock.calls[0]?.[0]?.gatewayPort).toBe(8123);
  });

  it("falls back to the configured port when --port is omitted (#83923 no-regression)", async () => {
    loadNodeHostConfigMock.mockImplementation(async () => ({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "127.0.0.1", port: 19000 },
    }));
    const program = createProgram();
    await program.parseAsync(["node", "run"], { from: "user" });

    expect(runtimeMocks.exit).not.toHaveBeenCalled();
    expect(runNodeHostMock.mock.calls[0]?.[0]?.gatewayPort).toBe(19000);
  });
});
