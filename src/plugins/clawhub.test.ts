/** Verifies ClawHub plugin spec parsing and install metadata handling. */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { createZipCentralDirectoryArchive } from "../test-utils/zip-central-directory-fixture.js";
import {
  clawHubArchiveFile,
  clawHubPackageDetail,
  createClawHubArchiveFactory,
  createLoggerSpies,
  DEMO_ARCHIVE_INTEGRITY,
  DEMO_ARCHIVE_SHA256,
  DEMO_CLAWPACK_INTEGRITY,
  DEMO_CLAWPACK_SHA256,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
  expectInstallFailure,
  expectInstallFailureFields,
  expectInstallSuccess,
  expectSuccessfulClawHubInstall,
  mockCallArg,
  setClawHubArchiveEntryMode,
  sha256Hex,
  type ArchiveInstallCall,
  type ClawHubArchiveFile,
  type PackageLookupCall,
} from "./clawhub.test-support.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageArtifactMock = vi.fn();
const fetchClawHubPackageSecurityMock = vi.fn();
const fetchClawHubPackageVersionMock = vi.fn();
const downloadClawHubPackageArchiveMock = vi.fn();
const archiveCleanupMock = vi.fn();
const resolveLatestVersionFromPackageMock = vi.fn();
const resolveCompatibilityHostVersionMock = vi.fn();
const installPluginFromArchiveMock = vi.fn();
const installExtractedArchiveMock = vi.fn();

vi.mock("../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
}));

vi.mock("../infra/clawhub-packages.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
    "../infra/clawhub-packages.js",
  );
  return {
    ...actual,
    fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
    fetchClawHubPackageArtifact: (...args: unknown[]) => fetchClawHubPackageArtifactMock(...args),
    fetchClawHubPackageSecurity: (...args: unknown[]) => fetchClawHubPackageSecurityMock(...args),
    fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
    resolveLatestVersionFromPackage: (...args: unknown[]) =>
      resolveLatestVersionFromPackageMock(...args),
  };
});

vi.mock("../infra/clawhub-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-artifacts.js")>(
    "../infra/clawhub-artifacts.js",
  );
  return {
    ...actual,
    downloadClawHubPackageArchive: (...args: unknown[]) =>
      downloadClawHubPackageArchiveMock(...args),
  };
});

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveCompatibilityHostVersion: (...args: unknown[]) =>
    resolveCompatibilityHostVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  },
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

vi.mock("../infra/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js");
  return {
    ...actual,
    DEFAULT_MAX_ENTRIES: 50_000,
    DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
    DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
  };
});

const { ClawHubRequestError } = await import("../infra/clawhub-client.js");
const { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } = await import("./clawhub.js");

const createClawHubArchive = createClawHubArchiveFactory(afterEach);

function mockClawHubVersionMetadata(overrides: Record<string, unknown> = {}) {
  fetchClawHubPackageVersionMock.mockResolvedValueOnce({
    version: {
      version: "2026.3.22",
      createdAt: 0,
      changelog: "",
      compatibility: {
        pluginApiRange: ">=2026.3.22",
        minGatewayVersion: "2026.3.0",
      },
      ...overrides,
    },
  });
}

async function mockClawHubFallbackArchive(params: {
  entries: Record<string, string>;
  files?: readonly ClawHubArchiveFile[];
  version?: Record<string, unknown>;
}) {
  const archive = await createClawHubArchive(params.entries);
  mockClawHubVersionMetadata({
    files:
      params.files ??
      Object.entries(params.entries)
        .filter(([filePath]) => filePath !== "_meta.json")
        .map(([filePath, contents]) => clawHubArchiveFile(filePath, contents)),
    ...params.version,
  });
  downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
    ...archive,
    cleanup: archiveCleanupMock,
  });
  return archive;
}

function mockCommunityClawHubPackageDetail() {
  fetchClawHubPackageDetailMock.mockResolvedValue(
    clawHubPackageDetail({ channel: "community", isOfficial: false }),
  );
}

function clawHubSecurityResponse(
  name = "demo",
  releaseVersion = "2026.3.22",
  trust: Record<string, unknown> = {},
  overview = "No security analysis has been recorded yet.",
) {
  return {
    package: { name, displayName: "Demo", family: "code-plugin" },
    release: { version: releaseVersion },
    overview,
    securityAuditUrl: `https://clawhub.ai/plugins/${name}/security-audit?version=${releaseVersion}`,
    trust: {
      scanStatus: "clean",
      moderationState: null,
      blockedFromDownload: false,
      reasons: [],
      pending: false,
      stale: false,
      ...trust,
    },
  };
}

function mockClawHubSecurity(
  trust: Record<string, unknown>,
  releaseVersion = "2026.3.22",
  overview = "The plugin can modify local OpenClaw state.",
) {
  fetchClawHubPackageSecurityMock.mockResolvedValueOnce(
    clawHubSecurityResponse("demo", releaseVersion, trust, overview),
  );
}

function mockOfficialClawHubPackageDetail(overrides: Record<string, unknown>): void {
  fetchClawHubPackageDetailMock.mockResolvedValueOnce(clawHubPackageDetail(overrides));
}

function packageDetailCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageDetailMock, callIndex) as PackageLookupCall;
}

function packageVersionCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageVersionMock, callIndex) as PackageLookupCall;
}

function archiveDownloadCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(downloadClawHubPackageArchiveMock, callIndex) as PackageLookupCall;
}

function archiveInstallCall(callIndex = 0): ArchiveInstallCall {
  return mockCallArg(installPluginFromArchiveMock, callIndex) as ArchiveInstallCall;
}

describe("installPluginFromClawHub", () => {
  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageArtifactMock.mockReset();
    fetchClawHubPackageSecurityMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    archiveCleanupMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    resolveCompatibilityHostVersionMock.mockReset();
    installPluginFromArchiveMock.mockReset();
    installExtractedArchiveMock.mockReset();

    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    fetchClawHubPackageDetailMock.mockResolvedValue(clawHubPackageDetail());
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.3.22");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    fetchClawHubPackageArtifactMock.mockImplementation((params) =>
      fetchClawHubPackageVersionMock(params),
    );
    fetchClawHubPackageSecurityMock.mockImplementation(
      (params: { name?: string; version?: string }) =>
        Promise.resolve(clawHubSecurityResponse(params.name, params.version)),
    );
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.3.22");
    installExtractedArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
    });
    installPluginFromArchiveMock.mockImplementation(
      async (
        params: Parameters<typeof import("./install-package.js").installPluginFromArchive>[0],
      ) => {
        if (!params.verification) {
          return await installExtractedArchiveMock();
        }
        return await withExtractedArchiveRoot({
          archivePath: params.archivePath,
          tempDirPrefix: "openclaw-clawhub-test-",
          timeoutMs: 10_000,
          verification: params.verification,
          rootMarkers: ["openclaw.plugin.json", "SKILL.md"],
          onExtracted: installExtractedArchiveMock,
        });
      },
    );
  });

  it("does not publish a ClawHub plugin after authority closes during artifact review", async () => {
    const archive = await mockClawHubFallbackArchive({
      entries: DEMO_PLUGIN_ARCHIVE_ENTRIES,
    });
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const { installPluginFromArchive } = await import("./install-package.js");
    installPluginFromArchiveMock.mockImplementationOnce(installPluginFromArchive);
    const archiveApi = await import("../infra/archive.js");
    const extraction = vi.spyOn(archiveApi, "extractArchive");
    let authorityActive = true;
    let result;
    try {
      result = await installPluginFromClawHub({
        spec: "clawhub:demo",
        extensionsDir,
        onBeforePluginArtifactCommit: async () => {
          authorityActive = false;
        },
        beforePersistentApply: () => {
          if (!authorityActive) {
            throw new Error("plugin installation authority closed");
          }
        },
      });
      expect(extraction).toHaveBeenCalledOnce();
    } finally {
      extraction.mockRestore();
    }

    expect(authorityActive).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin installation authority closed"),
    });
    await expect(fs.stat(path.join(extensionsDir, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["package runtimeId", { runtimeId: "demo-runtime" }],
    ["capabilities.runtimeId", { capabilities: { runtimeId: "demo-runtime" } }],
  ])("pins archive installation to the advertised %s", async (_label, overrides) => {
    mockOfficialClawHubPackageDetail(overrides);
    installPluginFromArchiveMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-runtime",
      targetDir: "/tmp/openclaw/plugins/demo-runtime",
      version: "2026.3.22",
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expect(expectInstallSuccess(result).pluginId).toBe("demo-runtime");
    expect(archiveInstallCall().expectedPluginId).toBe("demo-runtime");
  });

  it("rejects caller and advertised runtime id mismatches before download", async () => {
    mockOfficialClawHubPackageDetail({ runtimeId: "advertised-runtime" });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      expectedPluginId: "expected-runtime",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe("plugin_id_mismatch");
    expect(failure.error).toBe(
      'ClawHub package runtime id mismatch: expected "expected-runtime", got "advertised-runtime".',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects inconsistent advertised runtime ids before download", async () => {
    mockOfficialClawHubPackageDetail({
      runtimeId: "package-runtime",
      capabilities: { runtimeId: "capabilities-runtime" },
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe("plugin_id_mismatch");
    expect(failure.error).toBe(
      'ClawHub package runtime id mismatch: package advertises "package-runtime" but capabilities advertise "capabilities-runtime".',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("passes custom-registry provenance and authority to consent", async () => {
    const baseUrl = "https://plugins.example.test";
    const onBeforePluginArtifactCommit = vi.fn();
    installPluginFromArchiveMock.mockImplementationOnce(
      async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
        await params.onBeforePluginArtifactCommit({
          pluginId: "demo",
          stagedArtifactDir: "/tmp/openclaw/plugins/demo",
          mode: "install",
        });
        return { ok: true, pluginId: "demo", targetDir: "/tmp/openclaw/plugins/demo" };
      },
    );
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl,
      onBeforePluginArtifactCommit,
    });
    expect(result.ok).toBe(true);
    expect(onBeforePluginArtifactCommit).toHaveBeenCalledWith({
      pluginId: "demo",
      stagedArtifactDir: "/tmp/openclaw/plugins/demo",
      mode: "install",
      sourceRecord: {
        source: "clawhub",
        spec: "clawhub:demo",
        clawhubUrl: baseUrl,
        clawhubPackage: "demo",
        clawhubChannel: "official",
        integrity: DEMO_ARCHIVE_INTEGRITY,
      },
    });
    expect(archiveInstallCall().installPolicyRequest?.source).toEqual({
      kind: "clawhub",
      authority: "third-party",
      mutable: false,
      network: true,
    });
  });

  it("rejects a catalog archive integrity mismatch before extraction", async () => {
    const expectedIntegrity = `sha256-${Buffer.from("1".repeat(64), "hex").toString("base64")}`;
    const onBeforePluginArtifactCommit = vi.fn();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      expectedIntegrity,
      onBeforePluginArtifactCommit,
    });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive integrity mismatch for "demo@2026.3.22": expected ${expectedIntegrity}, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    );
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(onBeforePluginArtifactCommit).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes the ClawHub package summary link before logging", async () => {
    const logger = createLoggerSpies();

    await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai/\u001b]8;;https://evil.example\u0007\ninjected",
      logger,
    });

    const summary = logger.info.mock.calls.map(([message]) => message).join("\n");
    expect(summary).toContain("ClawHub");
    expect(summary).not.toContain("\u001b");
    expect(summary).not.toContain("\u0007");
    expect(summary).not.toContain("https://clawhub.ai/\ninjected");
    expect(summary).toContain("https://clawhub.ai/\\ninjected/plugins/demo");
  });

  it("blocks malicious ClawHub releases before missing-artifact fallback", async () => {
    mockCommunityClawHubPackageDetail();
    mockClawHubVersionMetadata();
    mockClawHubSecurity({
      scanStatus: "malicious",
      moderationState: "quarantined",
      blockedFromDownload: true,
      reasons: ["manual_moderation"],
    });
    const logger = { ...createLoggerSpies(), terminalLinks: true };

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    expect(failure.error).toBe("ClawHub blocked this release; install was not started.");
    expect(failure.warning).toContain("Outcome: Blocked");
    expect(failure.warning).not.toContain("\u001b");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Blocked"));
    const warning = logger.warn.mock.calls[0]?.[0] ?? "";
    expect(warning).toContain("Overview:");
    expect(warning).toContain("https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22");
    expect(warning).not.toContain('replying "Install"');
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("cancels before download when an interactive install confirmation is declined", async () => {
    mockCommunityClawHubPackageDetail();
    mockClawHubSecurity({ scanStatus: "not-run" });
    const confirmInstall = vi.fn(async () => false);
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      confirmInstall,
    });

    const failure = expectInstallFailure(result);
    expect(failure.error).toBe("Install cancelled.");
    expect(confirmInstall).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Outcome: Review"));
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("sanitizes ClawHub security identity mismatch labels before returning errors", async () => {
    mockCommunityClawHubPackageDetail();
    mockClawHubSecurity({}, "2026.3.21\nrewritten\u001b[2K");

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.error).toContain('returned version "2026.3.21\\nrewritten"');
    expect(failure.error).not.toContain("\n");
    expect(failure.error).not.toContain("\u001b");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("continues after printing a risky ClawHub release as Review", async () => {
    mockCommunityClawHubPackageDetail();
    const logger = { ...createLoggerSpies(), terminalLinks: true };
    mockClawHubSecurity(
      { scanStatus: "suspicious", reasons: ["payload_strings"] },
      "2026.3.22",
      "Audit summary\u001b[2K\nReview this line.",
    );

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      mode: "update",
    });

    expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
    const success = expectInstallSuccess(result);
    expect(success.clawhub?.clawhubTrustDisposition).toBe("review-required");
    expect(success.warning).toContain("Outcome: Review");
    expect(success.warning).toContain("Audit summary");
    expect(success.warning).toContain("Review this line.");
    expect(success.warning).not.toContain("\u001b");
    expect(success.clawhub?.clawhubTrustScanStatus).toBe("suspicious");
    expect(success.clawhub?.clawhubTrustReasons).toEqual(["payload_strings"]);
    expect(success.clawhub?.clawhubTrustCheckedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    expect(logger.warn.mock.calls.map(([message]) => message).join("\n")).toContain(
      "https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22",
    );
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalled();
  });

  it("accepts the live ClawHub artifact resolver shape with kind/sha256 field names", async () => {
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: "2026.3.22",
      artifact: {
        kind: "npm-pack",
        sha256: DEMO_CLAWPACK_SHA256,
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        size: 4096,
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.artifactFormat).toBe("tgz");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.npmShasum).toBe("1".repeat(40));
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(success.clawhub?.clawpackSize).toBe(4096);
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
  });

  it("accepts the live ClawHub legacy zip resolver shape with kind/sha256 field names", async () => {
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: "2026.3.22",
      artifact: {
        kind: "legacy-zip",
        sha256: DEMO_ARCHIVE_SHA256,
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
    expect(success.clawhub?.artifactKind).toBe("legacy-zip");
    expect(success.clawhub?.artifactFormat).toBe("zip");
    expect(success.clawhub?.integrity).toBe(DEMO_ARCHIVE_INTEGRITY);
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().artifact).toBe("archive");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
  });

  it("falls back to version metadata when the ClawHub artifact resolver route is missing", async () => {
    fetchClawHubPackageArtifactMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/2026.3.22/artifact",
        status: 404,
        body: "Not Found",
      }),
    );
    mockClawHubVersionMetadata({
      artifact: {
        kind: "npm-pack",
        format: "tgz",
        sha256: DEMO_CLAWPACK_SHA256,
        size: 4096,
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        npmTarballName: "demo-2026.3.22.tgz",
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.npmTarballName).toBe("demo-2026.3.22.tgz");
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(packageVersionCall().name).toBe("demo");
    expect(packageVersionCall().version).toBe("2026.3.22");
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
  });

  it("rejects ClawPack artifacts when the download digest does not match version metadata", async () => {
    const mismatchedSha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    mockClawHubVersionMetadata({
      artifact: { kind: "npm-pack", format: "tgz", sha256: DEMO_CLAWPACK_SHA256 },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: `sha256-${Buffer.from(mismatchedSha256, "hex").toString("base64")}`,
      sha256Hex: mismatchedSha256,
      artifact: "clawpack",
      clawpackHeaderSha256: mismatchedSha256,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH);
    expect(failure.error).toBe(
      `ClawHub ClawPack integrity mismatch for "demo@2026.3.22": expected ${DEMO_CLAWPACK_SHA256}, got ${mismatchedSha256}.`,
    );
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: 404,
      body: "Not Found",
      code: CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE,
      version: undefined,
      error:
        'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (404): Not Found). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    },
    {
      status: 403,
      body: "Blocked: this package release has been flagged as malicious and cannot be downloaded.",
      code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
      version: "2026.3.22",
      error:
        'ClawHub blocked artifact download for "demo@2026.3.22"; install was not started. ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (403): Blocked: this package release has been flagged as malicious and cannot be downloaded.',
    },
    {
      status: 403,
      body: "Forbidden.",
      code: CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE,
      version: undefined,
      error:
        'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (403): Forbidden.). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    },
  ])(
    "maps artifact download $status/$body to $code",
    async ({ status, body, code, version, error }) => {
      mockClawHubVersionMetadata({
        artifact: { kind: "npm-pack", format: "tgz", sha256: DEMO_CLAWPACK_SHA256 },
      });
      downloadClawHubPackageArchiveMock.mockRejectedValueOnce(
        new ClawHubRequestError({
          path: "/api/v1/packages/demo/versions/2026.3.22/artifact/download",
          status,
          body,
        }),
      );
      const result = await installPluginFromClawHub({
        spec: "clawhub:demo",
        baseUrl: "https://clawhub.ai",
      });
      expectInstallFailureFields(result, code, error);
      expect(expectInstallFailure(result).version).toBe(version);
      expect(archiveDownloadCall().artifact).toBe("clawpack");
      expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "does not inherit latest compatibility for a pinned older version",
      version: "2026.6.8",
      host: "2026.6.8",
      recovery: "absent",
      error: undefined,
    },
    {
      name: "recovers pinned compatibility from the version endpoint",
      version: "2026.6.8",
      host: "2026.6.5",
      recovery: "present",
      error: "2026.6.8",
    },
    {
      name: "fails closed when pinned compatibility recovery fails",
      version: "2026.6.8",
      host: "2026.6.8",
      recovery: "error",
      error: "500 Internal Server Error",
    },
    {
      name: "enforces latest package compatibility with sparse artifact metadata",
      version: "2026.6.10",
      host: "2026.6.8",
      recovery: "absent",
      error: "2026.6.10",
    },
  ])("$name", async ({ version, host, recovery, error }) => {
    const pinned = version === "2026.6.8";
    const spec = pinned ? `clawhub:demo@${version}` : "clawhub:demo";
    parseClawHubPluginSpecMock.mockReturnValueOnce({
      name: "demo",
      version: pinned ? version : undefined,
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.6.10");
    mockOfficialClawHubPackageDetail({
      latestVersion: "2026.6.10",
      compatibility: { pluginApiRange: ">=2026.6.10", minGatewayVersion: "2026.6.10" },
      artifact: { kind: "npm-pack", format: "tgz", sha256: DEMO_CLAWPACK_SHA256, size: 4096 },
    });
    resolveCompatibilityHostVersionMock.mockReturnValue(host);
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      version: { version, sha256hash: DEMO_ARCHIVE_SHA256 },
    });
    if (recovery === "error") {
      fetchClawHubPackageVersionMock.mockRejectedValueOnce(new Error("500 Internal Server Error"));
    } else {
      mockClawHubVersionMetadata({
        version,
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility:
          recovery === "present"
            ? { pluginApiRange: ">=2026.6.8", minGatewayVersion: "2026.6.8" }
            : undefined,
      });
    }
    const result = await installPluginFromClawHub({ spec, baseUrl: "https://clawhub.ai" });
    if (error) {
      expect(expectInstallFailure(result).error).toContain(error);
      expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    } else {
      expectSuccessfulClawHubInstall(result);
      const success = expectInstallSuccess(result);
      expect(success.clawhub?.clawpackSha256).toBeUndefined();
      expect(success.clawhub?.clawpackSpecVersion).toBeUndefined();
      expect(success.clawhub?.clawpackManifestSha256).toBeUndefined();
      expect(success.clawhub?.clawpackSize).toBeUndefined();
    }
  });

  it.each([
    {
      name: "installs when a beta runtime is on the same plugin API floor",
      host: "2026.5.27-beta.1",
      version: "2026.5.27",
      pluginApiRange: ">=2026.5.27",
      minGatewayVersion: "2026.3.0",
    },
    {
      name: "installs when a newer host satisfies a bare prerelease gateway minimum",
      host: "2026.8.1",
      version: "1.0.0-beta.3",
      pluginApiRange: ">=2026.7.2-beta.2",
      minGatewayVersion: "2026.7.2-beta.2",
    },
  ])("$name", async ({ host, version, pluginApiRange, minGatewayVersion }) => {
    resolveCompatibilityHostVersionMock.mockReturnValueOnce(host);
    mockClawHubVersionMetadata({
      version,
      sha256hash: DEMO_ARCHIVE_SHA256,
      compatibility: { pluginApiRange, minGatewayVersion },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expectSuccessfulClawHubInstall(result);
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledTimes(1);
    expect(installPluginFromArchiveMock).toHaveBeenCalledTimes(1);
    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("reports invalid gateway metadata distinctly from host incompatibility", async () => {
    mockClawHubVersionMetadata({
      compatibility: {
        pluginApiRange: ">=2026.3.22",
        minGatewayVersion: "not-semver",
      },
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.INVALID_GATEWAY_VERSION);
    expect(failure.error).toBe(
      'ClawHub package "demo" declares invalid minGatewayVersion metadata "not-semver"; report the package metadata to its publisher.',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("does not let a wildcard plugin API range hide an invalid runtime version", async () => {
    resolveCompatibilityHostVersionMock.mockReturnValueOnce("invalid");
    mockClawHubVersionMetadata({
      sha256hash: DEMO_ARCHIVE_SHA256,
      compatibility: {
        pluginApiRange: "*",
        minGatewayVersion: "2026.3.0",
      },
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(failure.error).toBe(
      'Plugin "demo" requires plugin API *, but this OpenClaw runtime exposes invalid.',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).not.toHaveBeenCalled();
  });

  it("validates _meta.json against canonical package and resolved version metadata", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "DemoAlias", version: "latest" });
    mockOfficialClawHubPackageDetail({ tags: { latest: "2026.3.22" } });
    await mockClawHubFallbackArchive({
      entries: {
        "openclaw.plugin.json": '{"id":"demo"}',
        "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
      },
      version: { sha256hash: null },
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:DemoAlias@latest",
      logger,
    });

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
    expect(success.version).toBe("2026.3.22");
    expect(packageDetailCall().name).toBe("DemoAlias");
    expect(packageVersionCall().name).toBe("demo");
    expect(packageVersionCall().version).toBe("2026.3.22");
    expect(fetchClawHubPackageSecurityMock).not.toHaveBeenCalled();
    expect(archiveInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(archiveInstallCall().installPolicyRequest?.source?.authority).toBe("official");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(success.packageName).toBe("demo");
    expect(success.clawhub?.clawhubPackage).toBe("demo");
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  const manifestFile = clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}');
  it.each([
    {
      name: "fails closed when sha256hash is present but unrecognized instead of silently falling back",
      metadata: {
        sha256hash: "definitely-not-a-sha256",
        files: [clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}')],
      },
      issue: 'has an invalid sha256hash (unrecognized value "definitely-not-a-sha256").',
    },
    {
      name: "fails closed when sha256hash is not a string",
      metadata: { sha256hash: 123 },
      issue: "has an invalid sha256hash (non-string value of type number).",
    },
    {
      name: "fails closed when files[] contains a malformed entry",
      metadata: {
        files: [null],
      },
      issue: "has an invalid files[0] entry (expected an object, got null).",
    },
    {
      name: "fails closed when files[] contains an invalid sha256",
      metadata: {
        files: [{ path: "openclaw.plugin.json", size: 13, sha256: "not-a-digest" }],
      },
      issue:
        'has an invalid files[0].sha256 (value "not-a-digest" is not a 64-character hexadecimal SHA-256 digest).',
    },
    {
      name: "rejects fallback metadata with an unsafe files[] path",
      metadata: {
        files: [{ path: "../evil.txt", size: 4, sha256: "1".repeat(64) }],
      },
      issue: 'has an invalid files[0].path (path "../evil.txt" contains dot segments).',
    },
    {
      name: "rejects fallback metadata with leading or trailing path whitespace",
      metadata: { files: [{ ...manifestFile, path: "openclaw.plugin.json " }] },
      issue:
        'has an invalid files[0].path (path "openclaw.plugin.json " has leading or trailing whitespace).',
    },
    {
      name: "rejects fallback metadata with duplicate files[] paths",
      metadata: { files: [manifestFile, manifestFile] },
      issue: 'has duplicate files[] path "openclaw.plugin.json".',
    },
    {
      name: "rejects fallback metadata when files[] includes generated _meta.json",
      metadata: {
        files: [
          {
            ...clawHubArchiveFile("_meta.json", '{"slug":"demo","version":"2026.3.22"}'),
            size: 64,
          },
        ],
      },
      issue: 'must not include generated file "_meta.json" in files[].',
    },
  ])("$name", async ({ metadata, issue }) => {
    mockClawHubVersionMetadata(metadata);
    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      `ClawHub version metadata for "demo@2026.3.22" ${issue}`,
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when sha256hash is explicitly null and files[] is unavailable", async () => {
    mockClawHubVersionMetadata({ sha256hash: null });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE);
    expect(failure.error).toBe(
      'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when the downloaded archive hash drifts from metadata", async () => {
    mockClawHubVersionMetadata({
      sha256hash: "1111111111111111111111111111111111111111111111111111111111111111",
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive integrity mismatch for "demo@2026.3.22": expected sha256-ERERERERERERERERERERERERERERERERERERERERERE=, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    );
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("keeps extraction failures typed and prevents install work after a corrupt ZIP payload", async () => {
    const archive = await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}' },
    });
    const bytes = await fs.readFile(archive.archivePath);
    const payloadOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[payloadOffset] = bytes[payloadOffset]! ^ 1;
    await fs.writeFile(archive.archivePath, bytes);
    const archiveApi = await import("../infra/archive.js");
    const extraction = vi.spyOn(archiveApi, "extractArchive");
    try {
      const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
      expectInstallFailureFields(
        result,
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        "ClawHub archive fallback verification failed while reading the downloaded archive.",
      );
      expect(extraction).toHaveBeenCalledOnce();
      expect(installExtractedArchiveMock).not.toHaveBeenCalled();
      expect(archiveCleanupMock).toHaveBeenCalledOnce();
    } finally {
      extraction.mockRestore();
    }
  });

  it("rejects fallback verification when an expected file is missing from the archive", async () => {
    await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}' },
      files: [
        clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}'),
        clawHubArchiveFile("dist/index.js", 'export const demo = "ok";'),
      ],
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": missing "dist/index.js".',
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "symlink",
      names: ["extra.txt"],
      mode: 0o120777,
      error:
        "ClawHub archive fallback verification rejected the downloaded archive: zip entry is a link: extra.txt",
    },
    {
      kind: "other",
      names: ["extra.txt"],
      mode: 0o160644,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "extra.txt".',
    },
    {
      kind: "case collision",
      names: ["README.md", "readme.md"],
      mode: undefined,
      error: expect.stringContaining(
        "ClawHub archive fallback verification rejected the downloaded archive: archive entries collide at output path",
      ),
    },
    {
      kind: "Unicode normalization collision",
      names: ["caf\u00e9.md", "cafe\u0301.md"],
      mode: undefined,
      error: expect.stringContaining(
        "ClawHub archive fallback verification rejected the downloaded archive: archive entries collide at output path",
      ),
    },
  ])(
    "explains portable ZIP $kind rejection before install work",
    async ({ names, mode, error }) => {
      const archive = await mockClawHubFallbackArchive({
        entries: {
          "openclaw.plugin.json": '{"id":"demo"}',
          ...Object.fromEntries(names.map((name) => [name, "unsupported"])),
        },
        files: [clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}')],
      });
      if (mode !== undefined) {
        await setClawHubArchiveEntryMode(archive.archivePath, "extra.txt", mode);
      }
      const { configureFsSafeNative, getFsSafeNativeConfig } =
        await import("@openclaw/fs-safe/config");
      const previous = getFsSafeNativeConfig();
      configureFsSafeNative({ mode: "off" });
      try {
        const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
        expect(result).toMatchObject({
          ok: false,
          code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
          error,
        });
        expect(installExtractedArchiveMock).not.toHaveBeenCalled();
        expect(archiveCleanupMock).toHaveBeenCalledOnce();
      } finally {
        configureFsSafeNative(previous);
      }
    },
  );

  it.each([
    { contents: "{not-json", error: "_meta.json is not valid JSON." },
    {
      contents: '{"slug":"wrong","version":"2026.3.22"}',
      error: "_meta.json slug does not match the package name.",
    },
  ])("rejects generated metadata: $error", async ({ contents, error }) => {
    await mockClawHubFallbackArchive({
      entries: {
        "openclaw.plugin.json": '{"id":"demo"}',
        "_meta.json": contents,
      },
    });
    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": ${error}`,
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when _meta.json exceeds the per-file size limit", async () => {
    const { archivePath } = await mockClawHubFallbackArchive({
      entries: {
        "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
        "openclaw.plugin.json": '{"id":"demo"}',
      },
    });
    const archiveBytes = await fs.readFile(archivePath);
    const centralDirectoryOffset = archiveBytes.readUInt32LE(archiveBytes.length - 6);
    // The first entry is _meta.json. Keep both size declarations consistent so
    // real ZIP admission reaches the per-file guard without allocating 256 MiB.
    const oversizedBytes = 256 * 1024 * 1024 + 1;
    archiveBytes.writeUInt32LE(oversizedBytes, 22);
    archiveBytes.writeUInt32LE(oversizedBytes, centralDirectoryOffset + 24);
    await fs.writeFile(archivePath, archiveBytes);
    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification exceeded the per-file size limit.",
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects underdeclared ZIP directory entries before parsing when the entry limit is exceeded", async () => {
    const { archivePath } = await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}' },
    });
    await fs.writeFile(
      archivePath,
      createZipCentralDirectoryArchive({
        actualEntryCount: 50_001,
        declaredEntryCount: 1,
        entryType: "directory",
      }),
    );
    const loadAsyncSpy = vi.spyOn(JSZip.prototype, "loadAsync");
    try {
      const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
      expectInstallFailureFields(
        result,
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        "ClawHub archive fallback verification exceeded the archive entry limit.",
      );
      expect(loadAsyncSpy).not.toHaveBeenCalled();
      expect(installExtractedArchiveMock).not.toHaveBeenCalled();
    } finally {
      loadAsyncSpy.mockRestore();
    }
  });

  it("rejects fallback verification when the downloaded archive exceeds the ZIP size limit", async () => {
    const archive = await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}' },
    });
    await fs.truncate(archive.archivePath, 256 * 1024 * 1024 + 1);

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when a file hash drifts from files[] metadata", async () => {
    const archive = await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}' },
      files: [{ path: "openclaw.plugin.json", size: 13, sha256: "1".repeat(64) }],
    });
    const { installPluginFromArchive } = await import("./install-package.js");
    installPluginFromArchiveMock.mockImplementationOnce(installPluginFromArchive);
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const beforePersistentApply = vi.fn();
    const onBeforePluginArtifactCommit = vi.fn();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      extensionsDir,
      beforePersistentApply,
      onBeforePluginArtifactCommit,
    });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
    expect(beforePersistentApply).not.toHaveBeenCalled();
    expect(onBeforePluginArtifactCommit).not.toHaveBeenCalled();
    await expect(fs.stat(extensionsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../extra.txt", "/extra.txt", "C:\\extra.txt", "a/../extra.txt", "a\0extra.txt"])(
    "rejects unsafe archive path %s before install work",
    async (filePath) => {
      await mockClawHubFallbackArchive({
        entries: { "openclaw.plugin.json": '{"id":"demo"}', [filePath]: "unsafe" },
        files: [manifestFile],
      });
      const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
      expect(result).toMatchObject({
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        error: expect.stringMatching(
          /^ClawHub archive fallback verification rejected the downloaded archive: archive entry /,
        ),
      });
      expect(installExtractedArchiveMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an undeclared file under its canonical extracted name", async () => {
    await mockClawHubFallbackArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}', "nested\\extra.txt": "unexpected" },
      files: [manifestFile],
    });
    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "nested/extra.txt".',
    );
    expect(installExtractedArchiveMock).not.toHaveBeenCalled();
  });

  it("verifies the canonical installed inventory and ignores inert root records", async () => {
    const entries = { ...DEMO_PLUGIN_ARCHIVE_ENTRIES, "nested\\extra.txt": "verified" };
    const archive = await mockClawHubFallbackArchive({
      entries: { ...entries, ".": "ignored" },
      files: Object.entries(entries).map(([name, contents]) =>
        clawHubArchiveFile(name.replaceAll("\\", "/"), contents),
      ),
    });
    await setClawHubArchiveEntryMode(archive.archivePath, ".", 0o120777);
    const { installPluginFromArchive } = await import("./install-package.js");
    installPluginFromArchiveMock.mockImplementationOnce(installPluginFromArchive);
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const logger = createLoggerSpies();
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      extensionsDir,
      expectedIntegrity: archive.integrity,
      logger,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(extensionsDir, "demo", "nested/extra.txt"), "utf8")).toBe(
      "verified",
    );
    expect(await fs.readFile(path.join(extensionsDir, "demo", "index.js"), "utf8")).toBe(
      DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: index.js, nested/extra.txt, openclaw.plugin.json, package.json.',
    );
  });

  it.each([
    {
      name: "reports an unknown host version distinctly from incompatibility",
      setup: () => {
        resolveCompatibilityHostVersionMock.mockReturnValueOnce("unknown");
        mockClawHubVersionMetadata({
          compatibility: { minGatewayVersion: "2026.3.22" },
        });
      },
      spec: "clawhub:demo",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.UNKNOWN_GATEWAY_VERSION,
        error:
          'Plugin "demo" requires OpenClaw >=2026.3.22, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.',
      },
    },
    {
      name: "redirects skill families before missing archive metadata checks",
      setup: () => {
        mockOfficialClawHubPackageDetail({
          name: "calendar",
          displayName: "Calendar",
          family: "skill",
          ownerHandle: "openclaw",
          compatibility: undefined,
        });
        mockClawHubVersionMetadata({
          compatibility: undefined,
        });
      },
      spec: "clawhub:calendar",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install @openclaw/calendar" instead.',
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
    setup();
    const result = await installPluginFromClawHub({ spec });
    expectInstallFailureFields(result, expected.code, expected.error);
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
