import { afterEach, expect, it, vi } from "vitest";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageSecurity,
  resolveLatestVersionFromPackage,
  searchClawHubPackages,
} from "./clawhub-packages.js";
import { captureClawHubJson as mockResponse } from "./clawhub.test-support.js";

const packageSelector = { name: "@openclaw/diagnostics-otel", version: "2026.3.22" };
const versionPath = "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22";
const securityReport = {
  package: { name: packageSelector.name, displayName: "Diagnostics", family: "code-plugin" },
  release: {
    releaseId: "rel_demo",
    version: packageSelector.version,
    artifactKind: "npm-pack",
    artifactSha256: "a".repeat(64),
    npmIntegrity: "sha512-proof",
    npmShasum: "abc",
  },
  overview: "The plugin uses privileged local APIs.\n\nReview those capabilities.",
  securityAuditUrl:
    "https://clawhub.ai/plugins/@openclaw/diagnostics-otel/security-audit?version=2026.3.22",
  trust: {
    scanStatus: "clean",
    moderationState: null,
    blockedFromDownload: false,
    reasons: [],
    pending: false,
    stale: true,
  },
};

afterEach(() => vi.restoreAllMocks());

it("requests official search results before ClawHub applies the result cap", async () => {
  const { url } = mockResponse({ results: [] });
  const query = { query: " research ", family: "claw", isOfficial: true, limit: 1 } as const;
  await expect(searchClawHubPackages(query)).resolves.toEqual([]);
  expect(url().pathname).toBe("/api/v1/packages/search");
  expect(Object.fromEntries(url().searchParams)).toEqual({
    q: "research",
    family: "claw",
    isOfficial: "true",
    limit: "1",
  });
});

it("resolves latest versions from latestVersion before tags", () => {
  const pkg = {
    name: "demo",
    displayName: "Demo",
    family: "code-plugin" as const,
    channel: "official" as const,
    isOfficial: true,
    createdAt: 0,
    updatedAt: 0,
    tags: { latest: "1.2.2" },
  };
  expect(resolveLatestVersionFromPackage({ package: { ...pkg, latestVersion: "1.2.3" } })).toBe(
    "1.2.3",
  );
  expect(resolveLatestVersionFromPackage({ package: pkg })).toBe("1.2.2");
});

it("fetches typed package artifact resolver reports", async () => {
  const report = {
    artifact: {
      source: "clawhub",
      artifactKind: "npm-pack",
      packageName: packageSelector.name,
      version: packageSelector.version,
      downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
      npmIntegrity: "sha512-demo",
      npmShasum: "abc",
    },
  };
  const { url } = mockResponse(report);
  await expect(fetchClawHubPackageArtifact(packageSelector)).resolves.toEqual(report);
  expect(url().pathname).toBe(`${versionPath}/artifact`);
});

it("fetches typed package security reports", async () => {
  const { url } = mockResponse(securityReport);
  const { releaseId, ...release } = securityReport.release;
  await expect(fetchClawHubPackageSecurity(packageSelector)).resolves.toEqual({
    ...securityReport,
    release: { ...release, id: releaseId },
  });
  expect(url().pathname).toBe(`${versionPath}/security`);
});

it.each([
  [
    { trust: { ...securityReport.trust, reasons: "clean", stale: false } },
    "reasons to be a string array",
  ],
  [
    {
      securityAuditUrl: securityReport.securityAuditUrl,
      trust: { blockedFromDownload: false, reasons: [], pending: false, stale: false },
    },
    "overview to be a non-empty string",
  ],
])("rejects malformed security report %j", async (report, error) => {
  mockResponse(report);
  await expect(fetchClawHubPackageSecurity(packageSelector)).rejects.toThrow(`expected ${error}`);
});
