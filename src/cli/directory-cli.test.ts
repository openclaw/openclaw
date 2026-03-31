import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDirectoryCli } from "./directory-cli.js";

const runtimeState = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
  return { defaultRuntime, runtimeLogs, runtimeErrors };
});

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
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

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeState.defaultRuntime,
}));

describe("registerDirectoryCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.runtimeLogs.length = 0;
    runtimeState.runtimeErrors.length = 0;
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "demo-channel",
      configured: ["demo-channel"],
      source: "explicit",
    });
    runtimeState.defaultRuntime.log.mockClear();
    runtimeState.defaultRuntime.error.mockClear();
    runtimeState.defaultRuntime.writeStdout.mockClear();
    runtimeState.defaultRuntime.writeJson.mockClear();
    runtimeState.defaultRuntime.exit.mockClear();
    runtimeState.defaultRuntime.exit.mockImplementation((code: number) => {
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
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        plugins: { entries: { "demo-directory": { enabled: true } } },
      }),
      baseHash: "config-1",
    });
    expect(self).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
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
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: autoEnabledConfig,
      baseHash: "config-1",
    });
  });
});
