import { beforeEach, describe, expect, it, vi } from "vitest";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageVersionMock = vi.fn();
const downloadClawHubPackageArchiveMock = vi.fn();
const resolveLatestVersionFromPackageMock = vi.fn();
const resolveCompatibilityHostVersionMock = vi.fn();
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
  };
});

vi.mock("../version.js", () => ({
  resolveCompatibilityHostVersion: (...args: unknown[]) =>
    resolveCompatibilityHostVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

const { ClawHubRequestError } = await import("../infra/clawhub.js");
const { CLAWHUB_INSTALL_ERROR_CODE, formatClawHubSpecifier, installPluginFromClawHub } =
  await import("./clawhub.js");

async function expectClawHubInstallError(params: {
  setup?: () => void;
  spec: string;
  expected: {
    ok: false;
    code: (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];
    error: string;
  };
}) {
  params.setup?.();
  await expect(installPluginFromClawHub({ spec: params.spec })).resolves.toMatchObject(
    params.expected,
  );
}

describe("installPluginFromClawHub", () => {
  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    resolveCompatibilityHostVersionMock.mockReset();
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
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.3.22");
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
    expect(info).toHaveBeenCalledWith("ClawHub code-plugin demo@2026.3.22 channel=official");
    expect(info).toHaveBeenCalledWith("Compatibility: pluginApi=>=2026.3.22 minGateway=2026.3.0");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects packages whose plugin API range exceeds the runtime version",
      setup: () => {
        resolveCompatibilityHostVersionMock.mockReturnValueOnce("2026.3.21");
      },
      spec: "clawhub:demo",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
        error:
          'Plugin "demo" requires plugin API >=2026.3.22, but this OpenClaw runtime exposes 2026.3.21.',
      },
    },
    {
      name: "rejects skill families and redirects to skills install",
      setup: () => {
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
      },
      spec: "clawhub:calendar",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
      },
    },
    {
      name: "returns typed package-not-found failures",
      setup: () => {
        fetchClawHubPackageDetailMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            path: "/api/v1/packages/demo",
            status: 404,
            body: "Package not found",
          }),
        );
      },
      spec: "clawhub:demo",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
        error: "Package not found on ClawHub.",
      },
    },
    {
      name: "returns typed version-not-found failures",
      setup: () => {
        parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "9.9.9" });
        fetchClawHubPackageVersionMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            path: "/api/v1/packages/demo/versions/9.9.9",
            status: 404,
            body: "Version not found",
          }),
        );
      },
      spec: "clawhub:demo@9.9.9",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
        error: "Version not found on ClawHub: demo@9.9.9.",
      },
    },
  ] as const)("$name", async ({ setup, spec, expected }) => {
    await expectClawHubInstallError({ setup, spec, expected });
  });
});
