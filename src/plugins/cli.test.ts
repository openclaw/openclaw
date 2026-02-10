import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  pluginTopLevelRegister: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: () => ({
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        commands: ["memory"],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: mocks.otherRegister,
        commands: ["other"],
        source: "bundled",
      },
      {
        pluginId: "foundry-plugin",
        register: mocks.pluginTopLevelRegister,
        commands: ["foundry-openclaw"],
        source: "workspace",
      },
    ],
  }),
}));

import { registerPluginCliCommands } from "./cli.js";

describe("registerPluginCliCommands", () => {
  beforeEach(() => {
    mocks.memoryRegister.mockClear();
    mocks.otherRegister.mockClear();
    mocks.pluginTopLevelRegister.mockClear();
  });

  it("skips plugin CLI registrars when commands already exist", () => {
    const program = new CommanderCommand();
    program.command("memory");

    // oxlint-disable-next-line typescript/no-explicit-any
    registerPluginCliCommands(program, {} as any);

    // memory-core is skipped because "memory" already exists on program
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    // other and foundry-openclaw do not overlap, so their registrars run
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
    expect(mocks.pluginTopLevelRegister).toHaveBeenCalledTimes(1);
  });

  it("calls all registrars and adds plugin subcommands when none overlap", () => {
    const program = new CommanderCommand();
    mocks.otherRegister.mockImplementation((ctx: { program: Command }) => {
      ctx.program.command("other").description("Other plugin");
    });
    mocks.pluginTopLevelRegister.mockImplementation((ctx: { program: Command }) => {
      ctx.program.command("foundry-openclaw").description("Foundry plugin CLI");
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    registerPluginCliCommands(program, {} as any);

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
    expect(mocks.pluginTopLevelRegister).toHaveBeenCalledTimes(1);
    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("other");
    expect(names).toContain("foundry-openclaw");
  });

  it("passes program, config, workspaceDir, and logger to each registrar", () => {
    const program = new CommanderCommand();
    const config = { plugins: {} };
    mocks.memoryRegister.mockImplementation(() => {});

    registerPluginCliCommands(program, config as Parameters<typeof registerPluginCliCommands>[1]);

    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        program,
        config,
      }),
    );
    const call = mocks.memoryRegister.mock.calls[0][0];
    expect(call).toHaveProperty("workspaceDir");
    expect(call).toHaveProperty("logger");
    expect(typeof call.logger.info).toBe("function");
  });
});
