// Verifies ClawHub package metadata, security, and artifact resolver APIs.
import { describe, expect, it } from "vitest";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageSecurity,
  resolveLatestVersionFromPackage,
} from "./clawhub-packages.js";

const packageSelector = { name: "@openclaw/diagnostics-otel", version: "2026.3.22" };
const securityReport = {
  package: { name: packageSelector.name, displayName: "Diagnostics", family: "code-plugin" },
  release: { releaseId: "rel_demo", version: packageSelector.version },
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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("clawhub packages", () => {
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
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageArtifact({
        ...packageSelector,
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return jsonResponse(report);
        },
      }),
    ).resolves.toEqual(report);
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/artifact",
    );
  });

  it("fetches typed package security reports", async () => {
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageSecurity({
        ...packageSelector,
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return jsonResponse(securityReport);
        },
      }),
    ).resolves.toEqual({
      ...securityReport,
      release: { id: "rel_demo", version: "2026.3.22" },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/security",
    );
  });

  it("rejects malformed package security reports", async () => {
    await expect(
      fetchClawHubPackageSecurity({
        ...packageSelector,
        fetchImpl: async () =>
          jsonResponse({ trust: { ...securityReport.trust, reasons: "clean", stale: false } }),
      }),
    ).rejects.toThrow("expected reasons to be a string array");
  });

  it("rejects package security reports without their audit overview", async () => {
    await expect(
      fetchClawHubPackageSecurity({
        ...packageSelector,
        fetchImpl: async () =>
          jsonResponse({
            securityAuditUrl: securityReport.securityAuditUrl,
            trust: { blockedFromDownload: false, reasons: [], pending: false, stale: false },
          }),
      }),
    ).rejects.toThrow("expected overview to be a non-empty string");
  });
});
