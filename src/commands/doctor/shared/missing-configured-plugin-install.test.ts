import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  resolveDefaultPluginExtensionsDir: vi.fn(() => "/tmp/openclaw-plugins"),
  resolveProviderInstallCatalogEntries: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

vi.mock("../../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords:
    mocks.writePersistedInstalledPluginIndexInstallRecords,
}));

vi.mock("../../../plugins/install-paths.js", () => ({
  resolveDefaultPluginExtensionsDir: mocks.resolveDefaultPluginExtensionsDir,
}));

vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

vi.mock("../../../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
  },
  installPluginFromClawHub: mocks.installPluginFromClawHub,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("../../../plugins/update.js", () => ({
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
}));

describe("repairMissingConfiguredPluginInstalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/plugin-matrix",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha256-clawhub",
        resolvedAt: "2026-05-01T00:00:00.000Z",
        clawpackSha256: "0".repeat(64),
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "1".repeat(64),
        clawpackSize: 1234,
      },
    });
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/plugin-matrix",
        version: "1.2.3",
        resolvedSpec: "@openclaw/plugin-matrix@1.2.3",
        integrity: "sha512-test",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
    });
  });

  it("installs a missing configured downloadable channel plugin", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
          expectedIntegrity: "sha512-test",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          matrix: { enabled: true },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/plugin-matrix@1.2.3",
        extensionsDir: "/tmp/openclaw-plugins",
        expectedPluginId: "matrix",
        expectedIntegrity: "sha512-test",
      }),
    );
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        matrix: expect.objectContaining({
          source: "npm",
          spec: "@openclaw/plugin-matrix@1.2.3",
          installPath: "/tmp/openclaw-plugins/matrix",
        }),
      }),
      { env: {} },
    );
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
  });

  it("installs a missing configured channel plugin from ClawHub before npm", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@1.2.3",
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
          expectedIntegrity: "sha512-test",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          matrix: { enabled: true },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/plugin-matrix@1.2.3",
        extensionsDir: "/tmp/openclaw-plugins",
        expectedPluginId: "matrix",
      }),
    );
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        matrix: expect.objectContaining({
          source: "clawhub",
          spec: "clawhub:@openclaw/plugin-matrix@1.2.3",
          installPath: "/tmp/openclaw-plugins/matrix",
          clawpackSha256: "0".repeat(64),
        }),
      }),
      { env: {} },
    );
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from clawhub:@openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to npm when a missing configured ClawHub package is absent", async () => {
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: false,
      code: "package_not_found",
      error: "Package not found on ClawHub.",
    });
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "matrix",
        label: "Matrix",
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@1.2.3",
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            matrix: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "clawhub:@openclaw/plugin-matrix@1.2.3" }),
    );
    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "@openclaw/plugin-matrix@1.2.3" }),
    );
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toEqual([
      "ClawHub clawhub:@openclaw/plugin-matrix@1.2.3 unavailable for matrix; falling back to npm @openclaw/plugin-matrix@1.2.3.",
    ]);
  });

  it("reinstalls a missing configured plugin from its persisted install record", async () => {
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: "/missing/demo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@openclaw/plugin-demo@1.0.0",
              installPath: "/tmp/openclaw-plugins/demo",
            },
          },
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated demo.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["demo"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({ installs: records }),
        }),
      }),
    );
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        demo: expect.objectContaining({ installPath: "/tmp/openclaw-plugins/demo" }),
      }),
      { env: {} },
    );
    expect(result.changes).toEqual(['Repaired missing configured plugin "demo".']);
  });
});
