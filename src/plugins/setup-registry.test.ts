import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  createJiti: vi.fn(),
  discoverOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("jiti", () => ({
  createJiti: (...args: Parameters<typeof mocks.createJiti>) => mocks.createJiti(...args),
}));

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: Parameters<typeof mocks.discoverOpenClawPlugins>) =>
    mocks.discoverOpenClawPlugins(...args),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: Parameters<typeof mocks.loadPluginManifestRegistry>) =>
    mocks.loadPluginManifestRegistry(...args),
}));

let clearPluginSetupRegistryCache: typeof import("./setup-registry.js").clearPluginSetupRegistryCache;
let resolvePluginSetupRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-setup-registry", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("setup-registry getJiti", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ clearPluginSetupRegistryCache, resolvePluginSetupRegistry } =
      await import("./setup-registry.js"));
    clearPluginSetupRegistryCache();
    mocks.createJiti.mockReset();
    mocks.discoverOpenClawPlugins.mockReset();
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.discoverOpenClawPlugins.mockReturnValue({
      candidates: [],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(
      (_modulePath: string, _options?: Record<string, unknown>) => {
        return () => ({ default: {} });
      },
    );
  });

  it("disables native jiti loading on Windows for setup-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      resolvePluginSetupRegistry({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "setup-api.js"));
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: false,
      }),
    );
  });
});
