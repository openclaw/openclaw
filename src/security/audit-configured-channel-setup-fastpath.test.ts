import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const {
  resolveConfiguredChannelPluginIdsMock,
  getBundledChannelSetupPluginMock,
  ensurePluginRegistryLoadedMock,
  listChannelPluginsMock,
  collectChannelSecurityFindingsMock,
} = vi.hoisted(() => ({
  resolveConfiguredChannelPluginIdsMock: vi.fn(),
  getBundledChannelSetupPluginMock: vi.fn(),
  ensurePluginRegistryLoadedMock: vi.fn(),
  listChannelPluginsMock: vi.fn(),
  collectChannelSecurityFindingsMock: vi.fn(async () => []),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: resolveConfiguredChannelPluginIdsMock,
}));

vi.mock("../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: getBundledChannelSetupPluginMock,
}));

vi.mock("../plugins/runtime/runtime-registry-loader.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: listChannelPluginsMock,
}));

vi.mock("./audit-channel.collect.runtime.js", () => ({
  collectChannelSecurityFindings: collectChannelSecurityFindingsMock,
}));

function makeReadonlyPlugin(id: string) {
  return {
    id,
    security: {},
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ id: "default" }),
    },
  };
}

describe("security audit configured-channel setup fast path", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    getBundledChannelSetupPluginMock.mockReset();
    ensurePluginRegistryLoadedMock.mockReset();
    listChannelPluginsMock.mockReset();
    collectChannelSecurityFindingsMock.mockReset();
    collectChannelSecurityFindingsMock.mockImplementation(async () => []);
  });

  it("uses bundled setup plugins when every configured channel exposes the required audit surface", async () => {
    const telegramSetup = makeReadonlyPlugin("telegram");
    const whatsappSetup = makeReadonlyPlugin("whatsapp");

    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["telegram", "whatsapp"]);
    getBundledChannelSetupPluginMock.mockImplementation((id: string) => {
      if (id === "telegram") {
        return telegramSetup;
      }
      if (id === "whatsapp") {
        return whatsappSetup;
      }
      return undefined;
    });

    const { runSecurityAudit } = await import("./audit.js");
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { enabled: true, token: "telegram-token" },
        whatsapp: { enabled: true, session: "whatsapp-session" },
      },
    };

    await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
    });

    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(listChannelPluginsMock).not.toHaveBeenCalled();
    expect(collectChannelSecurityFindingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        sourceConfig: cfg,
        plugins: [telegramSetup, whatsappSetup],
      }),
    );
  });

  it("falls back to the full configured-channel registry load when a setup plugin is insufficient", async () => {
    const telegramSetup = makeReadonlyPlugin("telegram");
    const fallbackPlugins = [makeReadonlyPlugin("telegram"), makeReadonlyPlugin("whatsapp")];

    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["telegram", "whatsapp"]);
    getBundledChannelSetupPluginMock.mockImplementation((id: string) => {
      if (id === "telegram") {
        return telegramSetup;
      }
      if (id === "whatsapp") {
        return {
          id,
          security: {},
          config: {
            listAccountIds: () => ["default"],
          },
        };
      }
      return undefined;
    });
    listChannelPluginsMock.mockReturnValue(fallbackPlugins);

    const { runSecurityAudit } = await import("./audit.js");
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { enabled: true, token: "telegram-token" },
        whatsapp: { enabled: true, session: "whatsapp-session" },
      },
    };

    await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "configured-channels",
        config: cfg,
        activationSourceConfig: cfg,
      }),
    );
    expect(listChannelPluginsMock).toHaveBeenCalled();
    expect(collectChannelSecurityFindingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: fallbackPlugins,
      }),
    );
  });
});
