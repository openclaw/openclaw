// Verifies prepared manifest metadata bypasses middleware discovery and keeps the standalone fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAgentToolResultMiddlewaresForRuntime } from "./agent-tool-result-middleware-loader.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("./manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry.js")>()),
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

function createManifestRegistry(): PluginManifestRegistry {
  const plugin: PluginManifestRecord = {
    id: "prepared-middleware",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/plugins/prepared-middleware",
    source: "/plugins/prepared-middleware/index.js",
    manifestPath: "/plugins/prepared-middleware/openclaw.plugin.json",
    contracts: {
      agentToolResultMiddleware: ["openclaw"],
    },
  };
  return { plugins: [plugin], diagnostics: [] };
}

function createRuntimeRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "prepared-middleware",
    pluginName: "prepared-middleware",
    rawHandler: () => undefined,
    handler: () => undefined,
    runtimes: ["openclaw"],
    source: "test",
  });
  return registry;
}

beforeEach(() => {
  mocks.loadOpenClawPlugins.mockReset().mockReturnValue(createRuntimeRegistry());
  mocks.loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistry());
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("loadAgentToolResultMiddlewaresForRuntime", () => {
  it("uses the prepared manifest registry without rediscovery", async () => {
    const config = {
      plugins: { entries: { "prepared-middleware": { enabled: true } } },
    } as OpenClawConfig;
    const env = { HOME: "/prepared-home" };
    const manifestRegistry = createManifestRegistry();

    const result = await loadAgentToolResultMiddlewaresForRuntime({
      runtime: "openclaw",
      config,
      workspaceDir: "/prepared-workspace",
      env,
      manifestRegistry,
    });

    expect(result).toHaveLength(1);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        env,
        workspaceDir: "/prepared-workspace",
        manifestRegistry,
        onlyPluginIds: ["prepared-middleware"],
      }),
    );
  });

  it("discovers metadata for standalone callers without a prepared registry", async () => {
    const config = {
      plugins: { entries: { "prepared-middleware": { enabled: true } } },
    } as OpenClawConfig;
    const env = { HOME: "/standalone-home" };

    const result = await loadAgentToolResultMiddlewaresForRuntime({
      runtime: "openclaw",
      config,
      workspaceDir: "/standalone-workspace",
      env,
    });

    expect(result).toHaveLength(1);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config,
      workspaceDir: "/standalone-workspace",
      env,
    });
  });
});
