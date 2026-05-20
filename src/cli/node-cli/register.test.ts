import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodeCli } from "./register.js";

const daemonMocks = vi.hoisted(() => ({
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonRestart: vi.fn(),
  runNodeDaemonStart: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
  runNodeDaemonStop: vi.fn(),
  runNodeDaemonUninstall: vi.fn(),
}));

type RunNodeHostStub = (opts: {
  gatewayHost?: string;
  gatewayPort?: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
}) => Promise<void>;

const nodeHostMocks = vi.hoisted(() => ({
  loadNodeHostConfig: vi.fn(async () => null as Awaited<unknown>),
  runNodeHost: vi.fn<RunNodeHostStub>(async () => {}),
}));

vi.mock("./daemon.js", () => daemonMocks);

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: nodeHostMocks.loadNodeHostConfig,
}));

vi.mock("../../node-host/runner.js", () => ({
  runNodeHost: nodeHostMocks.runNodeHost,
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
  it("registers node start for the macOS app node service manager", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "start", "--json"], { from: "user" });

    expect(daemonMocks.runNodeDaemonStart.mock.calls[0]?.[0]?.json).toBe(true);
  });
});

describe("openclaw node run --port validation (#83923)", () => {
  let originalExit: typeof process.exit;
  let exitSpy: ReturnType<typeof vi.fn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nodeHostMocks.runNodeHost.mockClear();
    nodeHostMocks.loadNodeHostConfig.mockReset();
    nodeHostMocks.loadNodeHostConfig.mockResolvedValue(null as Awaited<unknown>);

    originalExit = process.exit;
    // The action calls process.exit(2) on invalid --port; throw inside the mock
    // so the action stops and the test can observe both the stderr write and
    // the exit code without actually terminating the test runner.
    exitSpy = vi.fn((code?: number | string | null) => {
      throw new Error(`__test_exit__:${String(code)}`);
    });
    process.exit = exitSpy as unknown as typeof process.exit;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exit = originalExit;
    stderrSpy.mockRestore();
  });

  it("rejects --port abc with a loud diagnostic and does not start the host", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "run", "--port", "abc"], { from: "user" }),
    ).rejects.toThrow(/__test_exit__:2/);

    expect(nodeHostMocks.runNodeHost).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    const stderrMessages = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(stderrMessages.some((msg: string) => msg.includes("Invalid --port"))).toBe(true);
  });

  it("rejects --port 0 (out of range) without starting the host", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "run", "--port", "0"], { from: "user" }),
    ).rejects.toThrow(/__test_exit__:2/);

    expect(nodeHostMocks.runNodeHost).not.toHaveBeenCalled();
  });

  it("rejects --port 70000 (out of range) without starting the host", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "run", "--port", "70000"], { from: "user" }),
    ).rejects.toThrow(/__test_exit__:2/);

    expect(nodeHostMocks.runNodeHost).not.toHaveBeenCalled();
  });

  it("falls back to config / default gateway port when --port is absent", async () => {
    nodeHostMocks.loadNodeHostConfig.mockResolvedValueOnce({
      gateway: { port: 22222 },
    } as Awaited<unknown>);
    const program = createProgram();

    await program.parseAsync(["node", "run"], { from: "user" });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(nodeHostMocks.runNodeHost).toHaveBeenCalledTimes(1);
    expect(nodeHostMocks.runNodeHost.mock.calls[0][0]).toMatchObject({
      gatewayPort: 22222,
    });
  });

  it("uses the parsed --port value when valid", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "run", "--port", "31337"], { from: "user" });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(nodeHostMocks.runNodeHost).toHaveBeenCalledTimes(1);
    expect(nodeHostMocks.runNodeHost.mock.calls[0][0]).toMatchObject({ gatewayPort: 31337 });
  });
});
