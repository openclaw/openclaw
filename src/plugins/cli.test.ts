import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

import { registerPluginCliCommands } from "./cli.js";

describe("registerPluginCliCommands", () => {
  beforeEach(() => {
    mocks.memoryRegister.mockClear();
    mocks.otherRegister.mockClear();
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({
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
      ],
    });
  });

  it("skips plugin CLI registrars when commands already exist", () => {
    const program = new Command();
    program.command("memory");

    // oxlint-disable-next-line typescript/no-explicit-any
    registerPluginCliCommands(program, {} as any);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", () => {
    const program = new Command();
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    registerPluginCliCommands(program, {} as OpenClawConfig, env);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("keeps plugin loading activating so pairing setup can read channel plugins", () => {
    const program = new Command();

    registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        activate: false,
      }),
    );
  });
});
