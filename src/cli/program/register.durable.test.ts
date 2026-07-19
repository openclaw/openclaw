import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDurableCommand } from "./register.durable.js";

const mocks = vi.hoisted(() => ({
  createConfigIO: vi.fn(),
  durableCommand: vi.fn(),
  parseConfigJson5: vi.fn(),
  readSourceConfigBestEffort: vi.fn(),
  validateConfigObjectRaw: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/durable.js", () => ({
  durableCommand: mocks.durableCommand,
}));

vi.mock("../../config/config.js", () => ({
  createConfigIO: mocks.createConfigIO,
  parseConfigJson5: mocks.parseConfigJson5,
  validateConfigObjectRaw: mocks.validateConfigObjectRaw,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

function command(parent: Command, name: string): Command {
  const match = parent.commands.find((candidate) => candidate.name() === name);
  expect(match, `missing command: ${name}`).toBeDefined();
  return match!;
}

describe("registerDurableCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createConfigIO.mockReturnValue({
      configPath: "/private/tmp/openclaw-durable-config-does-not-exist.json",
      readSourceConfigBestEffort: mocks.readSourceConfigBestEffort,
    });
    mocks.parseConfigJson5.mockReturnValue({ ok: true, parsed: {} });
    mocks.readSourceConfigBestEffort.mockResolvedValue({ durable: { mode: "observe" } });
    mocks.validateConfigObjectRaw.mockReturnValue({
      ok: true,
      config: { durable: { mode: "observe" } },
    });
    mocks.durableCommand.mockResolvedValue(undefined);
  });

  async function runCli(args: string[]) {
    const program = new Command();
    registerDurableCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  it("registers source-oriented inspection resources without mutation actions", () => {
    const program = new Command();
    registerDurableCommand(program);

    const durable = command(program, "durable");
    expect(command(durable, "obligations").commands.map((child) => child.name())).toEqual(["list"]);
    expect(command(durable, "wakes").commands.map((child) => child.name())).toEqual([
      "list",
      "inspect",
    ]);
    expect(command(durable, "uncertainty").commands.map((child) => child.name())).toEqual(["list"]);
    expect(command(durable, "delivery-attempts").commands.map((child) => child.name())).toEqual([
      "list",
    ]);
    expect(durable.commands.map((child) => child.name())).not.toContain("wake");
    expect(durable.commands.map((child) => child.name())).toContain("health");
  });

  it("loads config without startup side effects and passes an isolated environment", async () => {
    await runCli(["durable", "health", "--json"]);

    expect(mocks.createConfigIO).toHaveBeenCalledWith({
      env: expect.any(Object),
      logger: {
        error: expect.any(Function),
        warn: expect.any(Function),
      },
      observe: false,
      pluginValidation: "skip",
      shellEnvFallback: "defer",
    });
    const configIoOptions = mocks.createConfigIO.mock.calls[0]?.[0] as {
      env: NodeJS.ProcessEnv;
    };
    expect(configIoOptions.env).not.toBe(process.env);
    expect(mocks.durableCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "health",
        durableConfig: { mode: "observe" },
        env: configIoOptions.env,
        json: true,
      }),
      mocks.runtime,
    );
  });

  it("passes an explicit off mode when durable config is absent", async () => {
    mocks.readSourceConfigBestEffort.mockResolvedValue({});
    mocks.validateConfigObjectRaw.mockReturnValue({ ok: true, config: {} });

    await runCli(["durable", "stats"]);

    expect(mocks.durableCommand).toHaveBeenCalledWith(
      expect.objectContaining({ durableConfig: { mode: "off" } }),
      mocks.runtime,
    );
  });

  it("reports config load failures without exposing local diagnostics", async () => {
    mocks.validateConfigObjectRaw.mockReturnValue({
      ok: false,
      issues: [{ path: "/private/operator/openclaw.json", message: "invalid config" }],
    });

    await runCli(["durable", "health", "--json"]);

    expect(mocks.durableCommand).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ error: "Unable to load OpenClaw config for durable inspection." }, null, 2),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(mocks.runtime.log.mock.calls)).not.toContain("/private/operator");
  });
});
