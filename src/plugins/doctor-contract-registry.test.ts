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

import {
  clearPluginDoctorContractRegistryCache,
  listPluginDoctorLegacyConfigRules,
} from "./doctor-contract-registry.js";

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry getJiti", () => {
  beforeEach(() => {
    clearPluginDoctorContractRegistryCache();
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

  it("disables native jiti loading on Windows for contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "contract-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      listPluginDoctorLegacyConfigRules({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "contract-api.js"));
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: false,
      }),
    );
  });
});
