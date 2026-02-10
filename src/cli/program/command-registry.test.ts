/**
 * Tests for program command registration.
 * Plugin CLI commands are registered in run-main (before parse), not during build,
 * so built-in commands like "memory" are registered first and plugin overlap is skipped.
 */

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerPluginCliCommandsMock = vi.fn();

vi.mock("../../plugins/cli.js", () => ({
  registerPluginCliCommands: registerPluginCliCommandsMock,
}));

const { registerProgramCommands } = await import("./command-registry.js");
const { createProgramContext } = await import("./context.js");

describe("registerProgramCommands", () => {
  let program: Command;
  let ctx: ReturnType<typeof createProgramContext>;

  beforeEach(() => {
    program = new Command();
    program.name("openclaw");
    ctx = createProgramContext();
    registerPluginCliCommandsMock.mockClear();
  });

  it("does not call registerPluginCliCommands (plugin CLI is registered in run-main)", () => {
    const argv = ["node", "openclaw", "status"];
    registerProgramCommands(program, ctx, argv);

    expect(registerPluginCliCommandsMock).not.toHaveBeenCalled();
  });

  it("registers built-in commands including memory so plugin overlap is avoided later", () => {
    const argv = ["node", "openclaw", "help"];
    registerProgramCommands(program, ctx, argv);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("memory");
  });
});
