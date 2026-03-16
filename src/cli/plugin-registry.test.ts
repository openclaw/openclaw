import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    mocks.loadConfig.mockReturnValue({
      plugins: { enabled: true },
      channels: { telegram: { enabled: false } },
    });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "telegram", channels: ["telegram"] },
        { id: "slack", channels: ["slack"] },
        { id: "openai", channels: [] },
      ],
    });
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [],
      tools: [],
    });
  });

  it("loads only configured channel plugins for configured-channels scope", async () => {
    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["telegram"],
      }),
    );
  });

  it("reloads when escalating from configured-channels to channels", async () => {
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
      expect.objectContaining({ onlyPluginIds: ["telegram"] }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ onlyPluginIds: ["telegram", "slack"] }),
    );
  });
});
