import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

const registerPluginCliCommandsFromValidatedConfig = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig,
}));

describe("nodes CLI JSON startup output routing", () => {
  const originalArgv = process.argv;
  let observedForceStderr: boolean | undefined;
  let originalForceConsoleToStderr: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    observedForceStderr = undefined;
    originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    registerPluginCliCommandsFromValidatedConfig.mockImplementation(async () => {
      observedForceStderr = loggingState.forceConsoleToStderr;
      return null;
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
  });

  it("routes plugin registration diagnostics to stderr when nodes is invoked with --json", async () => {
    process.argv = ["node", "openclaw", "nodes", "list", "--json"];
    const { registerNodesCli } = await import("./nodes-cli.js");

    await registerNodesCli(new Command());

    expect(observedForceStderr).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("preserves normal stdout routing for non-JSON nodes invocations", async () => {
    process.argv = ["node", "openclaw", "nodes", "list"];
    const { registerNodesCli } = await import("./nodes-cli.js");

    await registerNodesCli(new Command());

    expect(observedForceStderr).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
