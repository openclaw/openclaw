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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        loadBundledSecretProviderEntriesFromDir({
          dirName: "demo",
          pluginId: "demo",
        }),
      ).toMatchObject([{ id: "gcp", pluginId: "demo" }]);
      // Partial-success: the throwing sibling factory should produce a warning
      // (not a silent drop) so plugin authors get a diagnostic.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/plugin:demo.*native probe failed/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when a misshaped factory return is partial-success", () => {
    publicArtifactModule.createBrokenSecretProvider = () => ({ id: "bad" /* no resolve */ });
    publicArtifactModule.createGcpSecretProvider = () => ({
      id: "gcp",
      label: "GCP",
      resolve: vi.fn(),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = loadBundledSecretProviderEntriesFromDir({ dirName: "demo", pluginId: "demo" });
      expect(out).toMatchObject([{ id: "gcp", pluginId: "demo" }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(
        /createBrokenSecretProvider.*does not satisfy SecretProviderPlugin/,
      );
    } finally {
      warnSpy.mockRestore();
    }
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

    // When every factory in the artifact fails the shape check we throw so
    // plugin authors get a clear diagnostic instead of a silent missing source.
    let thrown: unknown;
    try {
      loadBundledSecretProviderEntriesFromDir({ dirName: "demo", pluginId: "demo" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Unable to initialize secret providers/);
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(
      /createBrokenSecretProvider.*does not satisfy SecretProviderPlugin/,
    );
  });
});
