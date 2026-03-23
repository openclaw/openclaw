import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDirectoryCli } from "./directory-cli.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  writeConfigFile: mocks.writeConfigFile,
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

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      log: (...args: unknown[]) => mocks.log(...args),
      error: (...args: unknown[]) => mocks.error(...args),
      writeStdout: (value: string) => mocks.log(value.endsWith("\n") ? value.slice(0, -1) : value),
      writeJson: (value: unknown, space = 2) =>
        mocks.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
      exit: (...args: unknown[]) => mocks.exit(...args),
    },
  };
});

describe("registerDirectoryCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      configured: ["slack"],
      source: "explicit",
    });
    mocks.exit.mockImplementation((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    });
  });

  it("installs an explicit optional directory channel on demand", async () => {
    const self = vi.fn().mockResolvedValue({ id: "self-1", name: "Family Phone" });
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: {
        channels: {},
        plugins: { entries: { whatsapp: { enabled: true } } },
      },
      channelId: "whatsapp",
      plugin: {
        id: "whatsapp",
        directory: { self },
      },
      configChanged: true,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--channel", "whatsapp", "--json"], {
      from: "user",
    });

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        rawChannel: "whatsapp",
        allowInstall: true,
      }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: { entries: { whatsapp: { enabled: true } } },
      }),
    );
    expect(self).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(mocks.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
