import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
  loadConfig: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [],
      tools: [],
    });
  });

  it("uses the auto-enabled config snapshot for configured channel scope", async () => {
    const baseConfig = {
      channels: {
        "demo-chat": {
          botToken: "demo-bot-token",
          appToken: "demo-app-token",
        },
      },
    };
    const autoEnabledConfig = {
      ...baseConfig,
      plugins: {
        entries: {
          "demo-chat": {
            enabled: true,
          },
        },
      },
    };

    mocks.loadConfig.mockReturnValue(baseConfig);
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "demo-chat", channels: ["demo-chat"] }],
      diagnostics: [],
    });

    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: baseConfig,
      env: process.env,
    });
    expect(mocks.resolveDefaultAgentId).toHaveBeenCalledWith(autoEnabledConfig);
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(autoEnabledConfig, "main");
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        onlyPluginIds: ["demo-chat"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when escalating from configured-channels to channels", async () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: false } },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.applyPluginAutoEnable.mockReturnValue({ config, changes: [] });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "demo-channel-a", channels: ["demo-channel-a"] },
        { id: "demo-channel-b", channels: ["demo-channel-b"] },
        { id: "demo-provider", channels: [] },
      ],
      diagnostics: [],
    });
    mocks.getActivePluginRegistry
      .mockReturnValueOnce({
        plugins: [],
        channels: [],
        tools: [],
      })
      .mockReturnValue({
        plugins: [{ id: "demo-channel-a" }],
        channels: [{ plugin: { id: "demo-channel-a" } }],
        tools: [],
      });

    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "configured-channels" });
    ensurePluginRegistryLoaded({ scope: "channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ onlyPluginIds: [], throwOnLoadError: true }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onlyPluginIds: ["demo-channel-a", "demo-channel-b"],
        throwOnLoadError: true,
      }),
    );
  });

  it("does not treat a pre-seeded partial registry as all scope", async () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: true } },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.applyPluginAutoEnable.mockReturnValue({ config, changes: [] });
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [{ plugin: { id: "demo-channel-a" } }],
      tools: [],
    });

    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "all" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not treat a tools-only pre-seeded registry as channel scope", async () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: true } },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.applyPluginAutoEnable.mockReturnValue({ config, changes: [] });
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [],
      tools: [{ pluginId: "demo-tool" }],
    });

    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when a pre-seeded channel registry is missing the configured channel plugin ids", async () => {
    const config = {
      plugins: { enabled: true },
      channels: {
        "demo-channel-a": {
          botToken: "demo-bot-token",
          appToken: "demo-app-token",
        },
      },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.applyPluginAutoEnable.mockReturnValue({ config, changes: [] });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "demo-channel-a", channels: ["demo-channel-a"] },
        { id: "demo-channel-b", channels: ["demo-channel-b"] },
      ],
      diagnostics: [],
    });
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [{ id: "demo-channel-b" }],
      channels: [{ plugin: { id: "demo-channel-b" } }],
      tools: [],
    });

    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
