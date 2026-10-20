import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

const registerPluginCliCommandsFromValidatedConfig = vi.fn(async () => ({}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig,
}));

const { registerNodesCli } = await import("./nodes-cli/register.js");

describe("registerNodesCli plugin registration", () => {
  const originalArgv = process.argv;
  let originalForceConsoleToStderr = false;

  beforeEach(() => {
    originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    registerPluginCliCommandsFromValidatedConfig.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
  });

  async function registerWithArgv(...args: string[]) {
    process.argv = ["node", "openclaw", "nodes", ...args];
    const program = new Command();
    await registerNodesCli(program);
    return program;
  }

  function expectLazyRegistration(program: Command) {
    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
  }

  async function captureStderrRouting(...args: string[]) {
    let routed: boolean | undefined;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      routed = loggingState.forceConsoleToStderr;
      return {};
    });
    const program = await registerWithArgv(...args);
    expect(loggingState.forceConsoleToStderr).toBe(false);
    return { program, routed };
  }

  it("skips plugin CLI/runtime registration for built-in nodes subcommands", async () => {
    for (const subcommand of ["status", "list", "describe", "invoke", "pending", "camera"]) {
      registerPluginCliCommandsFromValidatedConfig.mockClear();
      await registerWithArgv(subcommand, "--json");
      expect(registerPluginCliCommandsFromValidatedConfig).not.toHaveBeenCalled();
    }
  });

  it("registers plugin-provided node subcommands lazily and routes their logs to stderr", async () => {
    const { program, routed } = await captureStderrRouting("canvas", "snapshot", "--json");
    expectLazyRegistration(program);
    expect(routed).toBe(true);
  });

  it("surfaces plugin subcommands for bare `nodes` listing", async () => {
    expectLazyRegistration(await registerWithArgv());
  });

  it("documents the supported system.which parameter shape", async () => {
    const program = await registerWithArgv("--help");
    const nodesCommand = program.commands.find((command) => command.name() === "nodes");
    const output: string[] = [];

    nodesCommand?.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    nodesCommand?.outputHelp();
    const help = output.join("");

    expect(help).toContain(`--params '{"bins":["uname"]}'`);
    expect(help).not.toContain(`--params '{"name":"uname"}'`);
  });

  it("does not route pass-through --json after the terminator", async () => {
    const { routed } = await captureStderrRouting("canvas", "--", "--json");
    expect(routed).toBe(false);
  });
});
