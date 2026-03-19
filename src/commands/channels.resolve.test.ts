import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getChannelsCommandSecretTargetIds: vi.fn(() => []),
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: mocks.getChannelsCommandSecretTargetIds,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("./channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

const { channelsResolveCommand } = await import("./channels/resolve.js");

describe("channelsResolveCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "telegram",
      configured: ["telegram"],
      source: "explicit",
    });
  });

  it("persists install-on-demand channel setup before resolving explicit targets", async () => {
    const resolveTargets = vi.fn().mockResolvedValue([
      {
        input: "friends",
        resolved: true,
        id: "120363000000@g.us",
        name: "Friends",
      },
    ]);
    const installedCfg = {
      channels: {},
      plugins: {
        entries: {
          whatsapp: { enabled: true },
        },
      },
    };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: installedCfg,
      channelId: "whatsapp",
      configChanged: true,
      plugin: {
        id: "whatsapp",
        resolver: { resolveTargets },
      },
    });

    await channelsResolveCommand(
      {
        channel: "whatsapp",
        entries: ["friends"],
      },
      runtime,
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        rawChannel: "whatsapp",
        allowInstall: true,
      }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: installedCfg,
        inputs: ["friends"],
        kind: "group",
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });
});
