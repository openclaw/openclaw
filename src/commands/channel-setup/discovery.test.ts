import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ config, changes: [] })));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistry(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (args: unknown) => applyPluginAutoEnable(args),
}));

import { listManifestInstalledChannelIds } from "./discovery.js";

describe("listManifestInstalledChannelIds", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset();
    applyPluginAutoEnable.mockReset().mockImplementation(({ config }) => ({ config, changes: [] }));
  });

  it("uses the auto-enabled config snapshot for manifest discovery", () => {
    const autoEnabledConfig = {
      channels: { slack: { enabled: true } },
      plugins: { allow: ["slack"] },
      autoEnabled: true,
    } as never;
    applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: ["slack"] });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "slack", channels: ["slack"] }],
      diagnostics: [],
    });

    const installedIds = listManifestInstalledChannelIds({
      cfg: {} as never,
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(installedIds).toEqual(new Set(["slack"]));
  });
});
