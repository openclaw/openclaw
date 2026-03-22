import { beforeEach, describe, expect, it, vi } from "vitest";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageVersionMock = vi.fn();
const downloadClawHubPackageArchiveMock = vi.fn();
const resolveLatestVersionFromPackageMock = vi.fn();
const satisfiesPluginApiRangeMock = vi.fn();
const satisfiesGatewayMinimumMock = vi.fn();
const resolveRuntimeServiceVersionMock = vi.fn();
const installPluginFromArchiveMock = vi.fn();

vi.mock("../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
  fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
  fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
  downloadClawHubPackageArchive: (...args: unknown[]) => downloadClawHubPackageArchiveMock(...args),
  resolveLatestVersionFromPackage: (...args: unknown[]) =>
    resolveLatestVersionFromPackageMock(...args),
  satisfiesPluginApiRange: (...args: unknown[]) => satisfiesPluginApiRangeMock(...args),
  satisfiesGatewayMinimum: (...args: unknown[]) => satisfiesGatewayMinimumMock(...args),
}));

vi.mock("../version.js", () => ({
  resolveRuntimeServiceVersion: (...args: unknown[]) => resolveRuntimeServiceVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

const { formatClawHubSpecifier, installPluginFromClawHub } = await import("./clawhub.js");

describe("installPluginFromClawHub", () => {
  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    satisfiesPluginApiRangeMock.mockReset();
    satisfiesGatewayMinimumMock.mockReset();
    resolveRuntimeServiceVersionMock.mockReset();
    installPluginFromArchiveMock.mockReset();

    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    fetchClawHubPackageDetailMock.mockResolvedValue({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: "^1.2.0",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("1.2.3");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        version: "1.2.3",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: "^1.2.0",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: "sha256-demo",
    });
    satisfiesPluginApiRangeMock.mockReturnValue(true);
    resolveRuntimeServiceVersionMock.mockReturnValue("2026.3.14");
    satisfiesGatewayMinimumMock.mockReturnValue(true);
    installPluginFromArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "1.2.3",
    });
  });

  it("formats clawhub specifiers", () => {
    expect(formatClawHubSpecifier({ name: "demo" })).toBe("clawhub:demo");
    expect(formatClawHubSpecifier({ name: "demo", version: "1.2.3" })).toBe("clawhub:demo@1.2.3");
  });

  it("installs a ClawHub code plugin through the archive installer", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger: { info, warn },
    });

    expect(fetchClawHubPackageDetailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        baseUrl: "https://clawhub.ai",
      }),
    );
    expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "1.2.3",
      }),
    );
    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: "/tmp/clawhub-demo/archive.zip",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      pluginId: "demo",
      version: "1.2.3",
      clawhub: {
        source: "clawhub",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-demo",
      },
    });
    expect(info).toHaveBeenCalledWith("ClawHub code-plugin demo@1.2.3 channel=official");
    expect(info).toHaveBeenCalledWith("Compatibility: pluginApi=^1.2.0 minGateway=2026.3.0");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects skill families and redirects to skills install", async () => {
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "calendar",
        displayName: "Calendar",
        family: "skill",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
      },
    });

    await expect(installPluginFromClawHub({ spec: "clawhub:calendar" })).rejects.toThrow(
      'Use "openclaw skills install calendar" instead.',
    );
  });
});
