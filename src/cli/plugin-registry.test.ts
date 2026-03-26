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
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    };
    const autoEnabledConfig = {
      ...baseConfig,
      plugins: {
        entries: {
          slack: {
            enabled: true,
          },
        },
      },
    };

    mocks.loadConfig.mockReturnValue(baseConfig);
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "slack", channels: ["slack"] }],
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
        onlyPluginIds: ["slack"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when escalating from configured-channels to channels", async () => {
    const config = {
      plugins: { enabled: true },
      channels: { telegram: { enabled: false } },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.applyPluginAutoEnable.mockReturnValue({ config, changes: [] });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "telegram", channels: ["telegram"] },
        { id: "slack", channels: ["slack"] },
        { id: "openai", channels: [] },
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
        plugins: [{ id: "telegram" }],
        channels: [{ plugin: { id: "telegram" } }],
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
        onlyPluginIds: ["telegram", "slack"],
        throwOnLoadError: true,
      }),
    );
  });
});
