// Nodes CLI plugin registration tests cover node command plugin registration.
<<<<<<< HEAD
// Built-in node command registration runs for real so the guard is exercised against the actual
// registered subcommand names; only the plugin-loader boundary is stubbed.
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

const registerPluginCliCommandsFromValidatedConfig = vi.fn(async () => ({}));
<<<<<<< HEAD
=======
const registerNodesCameraCommands = vi.fn();
const registerNodesInvokeCommands = vi.fn();
const registerNodesLocationCommands = vi.fn();
const registerNodesNotifyCommand = vi.fn();
const registerNodesPairingCommands = vi.fn();
const registerNodesPushCommand = vi.fn();
const registerNodesScreenCommands = vi.fn();
const registerNodesStatusCommands = vi.fn();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig,
}));

<<<<<<< HEAD
=======
vi.mock("./nodes-cli/register.camera.js", () => ({ registerNodesCameraCommands }));
vi.mock("./nodes-cli/register.invoke.js", () => ({ registerNodesInvokeCommands }));
vi.mock("./nodes-cli/register.location.js", () => ({ registerNodesLocationCommands }));
vi.mock("./nodes-cli/register.notify.js", () => ({ registerNodesNotifyCommand }));
vi.mock("./nodes-cli/register.pairing.js", () => ({ registerNodesPairingCommands }));
vi.mock("./nodes-cli/register.push.js", () => ({ registerNodesPushCommand }));
vi.mock("./nodes-cli/register.screen.js", () => ({ registerNodesScreenCommands }));
vi.mock("./nodes-cli/register.status.js", () => ({ registerNodesStatusCommands }));

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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

  async function registerWithArgv(argv: string[]) {
    process.argv = argv;
    const program = new Command();
    await registerNodesCli(program);
    return program;
  }

<<<<<<< HEAD
  it("skips plugin CLI/runtime registration for built-in nodes subcommands", async () => {
    for (const subcommand of ["status", "list", "describe", "invoke", "pending", "camera"]) {
      registerPluginCliCommandsFromValidatedConfig.mockClear();
      await registerWithArgv(["node", "openclaw", "nodes", subcommand, "--json"]);
      expect(registerPluginCliCommandsFromValidatedConfig).not.toHaveBeenCalled();
    }
  });

  it("registers plugin-provided node subcommands lazily and routes their logs to stderr", async () => {
=======
  it("routes plugin registration logs to stderr for nodes --json commands", async () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    let forceStderrDuringRegistration = false;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

<<<<<<< HEAD
    const program = await registerWithArgv([
      "node",
      "openclaw",
      "nodes",
      "canvas",
      "snapshot",
      "--json",
    ]);
=======
    const program = await registerWithArgv(["node", "openclaw", "nodes", "list", "--json"]);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
    expect(forceStderrDuringRegistration).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

<<<<<<< HEAD
  it("surfaces plugin subcommands for bare `nodes` listing", async () => {
    const program = await registerWithArgv(["node", "openclaw", "nodes"]);
    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
  });

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  it("does not route pass-through --json after the terminator", async () => {
    let forceStderrDuringRegistration = true;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

<<<<<<< HEAD
    await registerWithArgv(["node", "openclaw", "nodes", "canvas", "--", "--json"]);
=======
    await registerWithArgv(["node", "openclaw", "nodes", "invoke", "--", "--json"]);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(forceStderrDuringRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
