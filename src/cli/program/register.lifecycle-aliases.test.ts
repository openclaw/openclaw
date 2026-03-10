import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runDaemonRestart = vi.fn();
const runDaemonStart = vi.fn();
const runDaemonStop = vi.fn();

vi.mock("../daemon-cli/runners.js", () => ({
  runDaemonRestart,
  runDaemonStart,
  runDaemonStop,
}));

let registerLifecycleAliasCommands: typeof import("./register.lifecycle-aliases.js").registerLifecycleAliasCommands;

beforeAll(async () => {
  ({ registerLifecycleAliasCommands } = await import("./register.lifecycle-aliases.js"));
});

describe("registerLifecycleAliasCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerLifecycleAliasCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runDaemonRestart.mockResolvedValue(undefined);
    runDaemonStart.mockResolvedValue(undefined);
    runDaemonStop.mockResolvedValue(undefined);
  });

  it("registers restart command with correct description", () => {
    const program = new Command();
    registerLifecycleAliasCommands(program);
    const cmd = program.commands.find((c) => c.name() === "restart");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Restart the Gateway service");
  });

  it("registers start command with correct description", () => {
    const program = new Command();
    registerLifecycleAliasCommands(program);
    const cmd = program.commands.find((c) => c.name() === "start");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Start the Gateway service");
  });

  it("registers stop command with correct description", () => {
    const program = new Command();
    registerLifecycleAliasCommands(program);
    const cmd = program.commands.find((c) => c.name() === "stop");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Stop the Gateway service");
  });

  it("delegates restart to runDaemonRestart", async () => {
    await runCli(["restart"]);
    expect(runDaemonRestart).toHaveBeenCalledWith({ json: false });
  });

  it("delegates restart --json to runDaemonRestart with json: true", async () => {
    await runCli(["restart", "--json"]);
    expect(runDaemonRestart).toHaveBeenCalledWith({ json: true });
  });

  it("delegates start to runDaemonStart", async () => {
    await runCli(["start"]);
    expect(runDaemonStart).toHaveBeenCalledWith({ json: false });
  });

  it("delegates start --json to runDaemonStart with json: true", async () => {
    await runCli(["start", "--json"]);
    expect(runDaemonStart).toHaveBeenCalledWith({ json: true });
  });

  it("delegates stop to runDaemonStop", async () => {
    await runCli(["stop"]);
    expect(runDaemonStop).toHaveBeenCalledWith({ json: false });
  });

  it("delegates stop --json to runDaemonStop with json: true", async () => {
    await runCli(["stop", "--json"]);
    expect(runDaemonStop).toHaveBeenCalledWith({ json: true });
  });
});
