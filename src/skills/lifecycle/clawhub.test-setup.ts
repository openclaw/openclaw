import { expect } from "vitest";
import {
  archiveCleanupMock,
  downloadClawHubGitHubSkillArchiveMock,
  downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrlMock,
  evaluateSkillInstallPolicyMock,
  fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolutionMock,
  fetchClawHubSkillSecurityVerdictsMock,
  fetchClawHubSkillVerificationMock,
  installPackageDirMock,
  isDefaultClawHubBaseUrlMock,
  markClawPackageIndependentlyOwnedMock,
  mockDefaultPackageInstall,
  pathExistsMock,
  reportClawHubSkillInstallTelemetryMock,
  resolveClawHubBaseUrlMock,
  searchClawHubSkillsMock,
  withExtractedArchiveRootMock,
} from "./clawhub.test-support.js";

export function resetClawHubSkillTestMocks(workspaceDir: string): void {
  fetchClawHubSkillDetailMock.mockReset();
  fetchClawHubSkillInstallResolutionMock.mockReset();
  fetchClawHubSkillVerificationMock.mockReset();
  fetchClawHubSkillSecurityVerdictsMock.mockReset();
  downloadClawHubSkillArchiveMock.mockReset();
  downloadClawHubSkillArchiveUrlMock.mockReset();
  downloadClawHubGitHubSkillArchiveMock.mockReset();
  reportClawHubSkillInstallTelemetryMock.mockReset();
  resolveClawHubBaseUrlMock.mockReset();
  isDefaultClawHubBaseUrlMock.mockReset();
  searchClawHubSkillsMock.mockReset();
  archiveCleanupMock.mockReset();
  withExtractedArchiveRootMock.mockReset();
  installPackageDirMock.mockReset();
  evaluateSkillInstallPolicyMock.mockReset();
  pathExistsMock.mockReset();
  markClawPackageIndependentlyOwnedMock.mockReset();

  resolveClawHubBaseUrlMock.mockImplementation((baseUrl?: string) =>
    (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
  );
  isDefaultClawHubBaseUrlMock.mockImplementation(
    (baseUrl?: string) => !baseUrl || baseUrl.replace(/\/+$/, "") === "https://clawhub.ai",
  );
  pathExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
  fetchClawHubSkillDetailMock.mockResolvedValue({
    skill: {
      slug: "agentreceipt",
      displayName: "AgentReceipt",
      createdAt: 1,
      updatedAt: 2,
    },
    latestVersion: {
      version: "1.0.0",
      createdAt: 3,
    },
  });
  fetchClawHubSkillInstallResolutionMock.mockResolvedValue({
    ok: true,
    slug: "agentreceipt",
    installKind: "archive",
    archive: {
      version: "1.0.0",
      downloadUrl: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
    },
  });
  fetchClawHubSkillVerificationMock.mockResolvedValue({
    schema: "clawhub.skill.verify.v1",
    ok: true,
    decision: "pass",
    reasons: [],
    card: { available: true, sha256: "card-sha" },
    artifact: { sourceFingerprint: "source-fp" },
    provenance: { source: "unavailable" },
    security: { status: "clean", signals: { staticScan: { engineVersion: "v2.4.24" } } },
    signature: { status: "unsigned" },
  });
  fetchClawHubSkillSecurityVerdictsMock.mockImplementation(
    async (params: { items: Array<{ slug: string; ownerHandle?: string; version: string }> }) => ({
      schema: "clawhub.skill.security-verdicts.v1",
      items: params.items.map((item) => ({
        ok: true,
        decision: "pass",
        reasons: [],
        requestedSlug: item.slug,
        requestedVersion: item.version,
        slug: item.slug,
        version: item.version,
        displayName: "Agent Receipt",
        ...(item.ownerHandle ? { publisherHandle: item.ownerHandle } : {}),
        overview: "No security analysis has been recorded yet.",
        securityAuditUrl: `https://clawhub.ai/${item.ownerHandle ?? "openclaw"}/skills/${item.slug}/security-audit?version=${item.version}`,
        security: {
          status: "clean",
          passed: true,
        },
      })),
    }),
  );
  const archive = {
    archivePath: "/tmp/agentreceipt.zip",
    integrity: "sha256-test",
    sha256Hex: "a".repeat(64),
    artifact: "archive",
    cleanup: archiveCleanupMock,
  };
  downloadClawHubSkillArchiveMock.mockResolvedValue(archive);
  downloadClawHubSkillArchiveUrlMock.mockResolvedValue(archive);
  downloadClawHubGitHubSkillArchiveMock.mockResolvedValue({
    ...archive,
    archivePath: "/tmp/github-agentreceipt.zip",
    integrity: "sha256-github-test",
    sha256Hex: "b".repeat(64),
  });
  reportClawHubSkillInstallTelemetryMock.mockResolvedValue(undefined);
  archiveCleanupMock.mockResolvedValue(undefined);
  searchClawHubSkillsMock.mockResolvedValue([]);
  withExtractedArchiveRootMock.mockImplementation(async (params) => {
    expect(params.rootMarkers).toEqual(["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]);
    return await params.onExtracted("/tmp/extracted-skill");
  });
  mockDefaultPackageInstall(workspaceDir);
  evaluateSkillInstallPolicyMock.mockResolvedValue(undefined);
}
