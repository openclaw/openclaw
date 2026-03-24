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

vi.mock("../infra/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub.js")>("../infra/clawhub.js");
  return {
    ...actual,
    parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
    fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
    fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
    downloadClawHubPackageArchive: (...args: unknown[]) =>
      downloadClawHubPackageArchiveMock(...args),
    resolveLatestVersionFromPackage: (...args: unknown[]) =>
      resolveLatestVersionFromPackageMock(...args),
    satisfiesPluginApiRange: (...args: unknown[]) => satisfiesPluginApiRangeMock(...args),
    satisfiesGatewayMinimum: (...args: unknown[]) => satisfiesGatewayMinimumMock(...args),
  };
});

vi.mock("../version.js", () => ({
  resolveRuntimeServiceVersion: (...args: unknown[]) => resolveRuntimeServiceVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

const { ClawHubRequestError } = await import("../infra/clawhub.js");
const { CLAWHUB_INSTALL_ERROR_CODE, formatClawHubSpecifier, installPluginFromClawHub } =
  await import("./clawhub.js");

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
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.3.22");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: "sha256-demo",
    });
    satisfiesPluginApiRangeMock.mockReturnValue(true);
    resolveRuntimeServiceVersionMock.mockReturnValue("2026.3.22");
    satisfiesGatewayMinimumMock.mockReturnValue(true);
    installPluginFromArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
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
        version: "2026.3.22",
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
      version: "2026.3.22",
      clawhub: {
        source: "clawhub",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-demo",
      },
    });
    expect(satisfiesPluginApiRangeMock).toHaveBeenCalledWith("2026.3.22", ">=2026.3.22");
    expect(satisfiesGatewayMinimumMock).toHaveBeenCalledWith("2026.3.22", "2026.3.0");
    expect(info).toHaveBeenCalledWith("ClawHub code-plugin demo@2026.3.22 channel=official");
    expect(info).toHaveBeenCalledWith("Compatibility: pluginApi=>=2026.3.22 minGateway=2026.3.0");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects packages whose plugin API range exceeds the runtime version", async () => {
    resolveRuntimeServiceVersionMock.mockReturnValueOnce("2026.3.21");
    satisfiesPluginApiRangeMock.mockReturnValueOnce(false);

    await expect(installPluginFromClawHub({ spec: "clawhub:demo" })).resolves.toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
      error:
        'Plugin "demo" requires plugin API >=2026.3.22, but this OpenClaw runtime exposes 2026.3.21.',
    });

    expect(satisfiesPluginApiRangeMock).toHaveBeenCalledWith("2026.3.21", ">=2026.3.22");
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

    await expect(installPluginFromClawHub({ spec: "clawhub:calendar" })).resolves.toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
      error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
    });
  });

  it("returns typed package-not-found failures", async () => {
    fetchClawHubPackageDetailMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo",
        status: 404,
        body: "Package not found",
      }),
    );

    await expect(installPluginFromClawHub({ spec: "clawhub:demo" })).resolves.toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
      error: "Package not found on ClawHub.",
    });
  });

  it("returns typed version-not-found failures", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "9.9.9" });
    fetchClawHubPackageVersionMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/9.9.9",
        status: 404,
        body: "Version not found",
      }),
    );

    await expect(installPluginFromClawHub({ spec: "clawhub:demo@9.9.9" })).resolves.toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
      error: "Version not found on ClawHub: demo@9.9.9.",
    });
  });
});
