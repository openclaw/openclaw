import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

import { registerPluginCliCommands } from "./cli.js";

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry() {
  return {
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
  };
}

function expectPluginLoaderConfig(config: OpenClawConfig) {
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      config,
    }),
  );
}

describe("registerPluginCliCommands", () => {
  beforeEach(() => {
    mocks.memoryRegister.mockClear();
    mocks.otherRegister.mockClear();
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue(createCliRegistry());
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
  });

  it("skips plugin CLI registrars when commands already exist", () => {
    const program = createProgram("memory");

    // oxlint-disable-next-line typescript/no-explicit-any
    registerPluginCliCommands(program, {} as any);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", () => {
    const program = createProgram();
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    registerPluginCliCommands(program, {} as OpenClawConfig, env);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", () => {
    const program = createProgram();
    const rawConfig = {
      plugins: {},
      channels: { demo: { enabled: true } },
    } as OpenClawConfig;
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    registerPluginCliCommands(program, rawConfig);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expectPluginLoaderConfig(autoEnabledConfig);
    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });
});
