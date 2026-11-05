import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

let routed: boolean | undefined;
const registerPluginCliCommandsFromValidatedConfig = vi.fn(async () => {
  routed = loggingState.forceConsoleToStderr;
  return {};
});

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
    routed = undefined;
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

  it("skips plugin CLI/runtime registration for built-in nodes subcommands", async () => {
    for (const subcommand of ["status", "list", "describe", "invoke", "pending", "camera"]) {
      registerPluginCliCommandsFromValidatedConfig.mockClear();
      await registerWithArgv(subcommand, "--json");
      expect(registerPluginCliCommandsFromValidatedConfig).not.toHaveBeenCalled();
    }
  });

  it.each([
    { args: ["canvas", "snapshot", "--json"], stderr: true },
    { args: [], stderr: false },
    { args: ["canvas", "--", "--json"], stderr: false },
  ])("lazily registers nodes $args with stderr routing=$stderr", async ({ args, stderr }) => {
    const program = await registerWithArgv(...args);
    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
    expect({ during: routed, after: loggingState.forceConsoleToStderr }).toEqual({
      during: stderr,
      after: false,
    });
  });

  it("documents current pairing and system.which command syntax", async () => {
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
    expect(help).toContain("openclaw nodes pending");
    expect(help).not.toContain("openclaw nodes pairing pending");
  });
});
