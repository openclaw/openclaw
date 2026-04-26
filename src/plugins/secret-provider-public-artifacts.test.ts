import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicArtifactModule } = vi.hoisted(() => ({
  publicArtifactModule: {} as Record<string, unknown>,
}));

vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => publicArtifactModule),
  resolveBundledPluginPublicArtifactPath: vi.fn(() => "/repo/extensions/demo/secret-provider.ts"),
}));

import { loadBundledSecretProviderEntriesFromDir } from "./secret-provider-public-artifacts.js";

describe("loadBundledSecretProviderEntriesFromDir", () => {
  beforeEach(() => {
    for (const key of Object.keys(publicArtifactModule)) {
      delete publicArtifactModule[key];
    }
  });

  it("isolates a throwing factory when another secret-provider factory succeeds", () => {
    publicArtifactModule.createBrokenSecretProvider = () => {
      throw new Error("native probe failed");
    };
    publicArtifactModule.createGcpSecretProvider = () => ({
      id: "gcp",
      label: "GCP Secret Manager",
      resolve: vi.fn(),
    });

    expect(
      loadBundledSecretProviderEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toMatchObject([{ id: "gcp", pluginId: "demo" }]);
  });

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("native probe failed");
    publicArtifactModule.createGcpSecretProvider = () => {
      throw cause;
    };

    expect(() =>
      loadBundledSecretProviderEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toThrow("Unable to initialize secret providers for plugin demo");
  });

  it("ignores exports that are not factory functions", () => {
    publicArtifactModule.createGcpSecretProvider = () => ({
      id: "gcp",
      label: "GCP",
      resolve: vi.fn(),
    });
    publicArtifactModule.unrelatedExport = { id: "noise" };
    publicArtifactModule.gcpProvider = { id: "gcp", label: "x", resolve: vi.fn() };

    const out = loadBundledSecretProviderEntriesFromDir({
      dirName: "demo",
      pluginId: "demo",
    });
    expect(out).toMatchObject([{ id: "gcp", pluginId: "demo" }]);
    expect(out).toHaveLength(1);
  });

  it("rejects factory output that is missing required SecretProviderPlugin fields", () => {
    publicArtifactModule.createBrokenSecretProvider = () => ({ id: "bad" /* no resolve */ });

    expect(
      loadBundledSecretProviderEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toBeNull();
  });
});
