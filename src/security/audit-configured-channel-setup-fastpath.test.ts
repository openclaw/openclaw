import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const {
  hasPotentialConfiguredChannelsMock,
  resolveConfiguredChannelPluginIdsMock,
  getBundledChannelSetupPluginMock,
  loadPluginManifestRegistryMock,
  ensurePluginRegistryLoadedMock,
  listChannelPluginsMock,
  collectChannelSecurityFindingsMock,
} = vi.hoisted(() => ({
  hasPotentialConfiguredChannelsMock: vi.fn(() => true),
  resolveConfiguredChannelPluginIdsMock: vi.fn(),
  getBundledChannelSetupPluginMock: vi.fn(),
  loadPluginManifestRegistryMock: vi.fn(),
  ensurePluginRegistryLoadedMock: vi.fn(),
  listChannelPluginsMock: vi.fn(),
  collectChannelSecurityFindingsMock: vi.fn(async () => []),
}));

vi.mock("../channels/config-presence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/config-presence.js")>();
  return {
    ...actual,
    hasPotentialConfiguredChannels: hasPotentialConfiguredChannelsMock,
  };
});

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: resolveConfiguredChannelPluginIdsMock,
}));

vi.mock("../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: getBundledChannelSetupPluginMock,
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: loadPluginManifestRegistryMock,
  };
});

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

function makeConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: "/workspace/test-agent",
      },
    },
    channels: {
      telegram: { enabled: true, botToken: "telegram-token" },
      whatsapp: { enabled: true, selfChatMode: true },
    },
  };
}

describe("security audit configured-channel setup fast path", () => {
  beforeEach(() => {
    vi.resetModules();
    hasPotentialConfiguredChannelsMock.mockReset();
    hasPotentialConfiguredChannelsMock.mockReturnValue(true);
    resolveConfiguredChannelPluginIdsMock.mockReset();
    getBundledChannelSetupPluginMock.mockReset();
    loadPluginManifestRegistryMock.mockReset();
    ensurePluginRegistryLoadedMock.mockReset();
    listChannelPluginsMock.mockReset();
    collectChannelSecurityFindingsMock.mockReset();
    collectChannelSecurityFindingsMock.mockImplementation(async () => []);
  });

  it("uses bundled setup plugins when every configured channel exposes the required audit surface", async () => {
    const telegramSetup = makeReadonlyPlugin("telegram");
    const whatsappSetup = makeReadonlyPlugin("whatsapp");

    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["telegram", "whatsapp"]);
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        { id: "telegram", origin: "bundled" },
        { id: "whatsapp", origin: "bundled" },
      ],
      diagnostics: [],
    });
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
    const cfg = makeConfig();

    await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
    });

    expect(resolveConfiguredChannelPluginIdsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        workspaceDir: "/workspace/test-agent",
      }),
    );
    expect(loadPluginManifestRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        workspaceDir: "/workspace/test-agent",
      }),
    );
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
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        { id: "telegram", origin: "bundled" },
        { id: "whatsapp", origin: "bundled" },
      ],
      diagnostics: [],
    });
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
    const cfg = makeConfig();

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

  it("falls back when a configured channel is shadowed by a non-bundled plugin winner", async () => {
    const fallbackPlugins = [makeReadonlyPlugin("telegram"), makeReadonlyPlugin("whatsapp")];

    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["telegram", "whatsapp"]);
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        { id: "telegram", origin: "bundled" },
        { id: "whatsapp", origin: "workspace" },
      ],
      diagnostics: [],
    });
    getBundledChannelSetupPluginMock.mockImplementation((id: string) => makeReadonlyPlugin(id));
    listChannelPluginsMock.mockReturnValue(fallbackPlugins);

    const { runSecurityAudit } = await import("./audit.js");
    const cfg = makeConfig();

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
