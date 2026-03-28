import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDirectoryCli } from "./directory-cli.js";
import type { CliRuntimeCapture } from "./test-runtime-capture.js";

const runtimeState = vi.hoisted(() => ({ capture: null as CliRuntimeCapture | null }));

function getRuntimeCapture(): CliRuntimeCapture {
  if (!runtimeState.capture) {
    throw new Error("runtime capture not initialized");
  }
  return runtimeState.capture;
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  writeConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../commands/channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../runtime.js", async () => {
  const { createCliRuntimeCapture } = await import("./test-runtime-capture.js");
  runtimeState.capture ??= createCliRuntimeCapture();
  return { defaultRuntime: runtimeState.capture.defaultRuntime };
});

describe("registerDirectoryCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRuntimeCapture().resetRuntimeCapture();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "demo-channel",
      configured: ["demo-channel"],
      source: "explicit",
    });
    getRuntimeCapture().defaultRuntime.exit.mockImplementation((code: number) => {
      throw new Error(`exit:${code}`);
    });
  });

  it("installs an explicit optional directory channel on demand", async () => {
    const self = vi.fn().mockResolvedValue({ id: "self-1", name: "Family Phone" });
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: {
        channels: {},
        plugins: { entries: { "demo-directory": { enabled: true } } },
      },
      channelId: "demo-directory",
      plugin: {
        id: "demo-directory",
        directory: { self },
      },
      configChanged: true,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--channel", "demo-directory", "--json"], {
      from: "user",
    });

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        rawChannel: "demo-directory",
        allowInstall: true,
      }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: { entries: { "demo-directory": { enabled: true } } },
      }),
    );
    expect(self).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(getRuntimeCapture().defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(getRuntimeCapture().defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("uses the auto-enabled config snapshot for omitted channel selection", async () => {
    const autoEnabledConfig = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    const self = vi.fn().mockResolvedValue({ id: "self-2", name: "WhatsApp Bot" });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["whatsapp"],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      configured: ["whatsapp"],
      source: "single-configured",
    });
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      directory: { self },
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--json"], { from: "user" });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: { channels: {} },
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
      channel: null,
    });
    expect(self).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledConfig,
      }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(autoEnabledConfig);
  });
});
