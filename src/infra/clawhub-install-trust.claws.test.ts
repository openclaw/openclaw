import { describe, expect, it, vi } from "vitest";
import { checkClawHubPackageTrust } from "./clawhub-install-trust.js";

const subject = { kind: "claw" as const, packageName: "@openclaw/research-briefing" };
const version = "1.0.0";
const expectedClawArtifact = {
  sha256: "a".repeat(64),
  npmIntegrity: "sha512-proof",
};

function securityResponse(
  family: string,
  warned = false,
  verdict: string | null = "benign",
  trustOverrides: Record<string, unknown> = {},
  releaseOverrides: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      package: { name: subject.packageName, displayName: "Research Briefing", family },
      release: {
        version,
        artifactKind: "npm-pack",
        artifactSha256: expectedClawArtifact.sha256,
        npmIntegrity: expectedClawArtifact.npmIntegrity,
        ...releaseOverrides,
      },
      overview: "No concerning capabilities found.",
      ...(verdict ? { verdict } : {}),
      securityAuditUrl: "https://clawhub.example/audit",
      trust: {
        scanStatus: warned ? "suspicious" : "clean",
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: warned ? ["scan:suspicious"] : [],
        pending: false,
        stale: false,
        ...trustOverrides,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("ClawHub Claw trust", () => {
  it("checks the exact Claw release through the current package security route", async () => {
    let requestedUrl = "";
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      baseUrl: "https://clawhub.example",
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return securityResponse("claw");
      },
    });

    expect(result).toMatchObject({
      ok: true,
      trustInstallRecordFields: { clawhubTrustDisposition: "clean" },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fresearch-briefing/versions/1.0.0/security",
    );
  });

  it("rejects a clean security verdict for different Claw artifact bytes", async () => {
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      fetchImpl: async () =>
        securityResponse("claw", false, "benign", {}, { artifactSha256: "b".repeat(64) }),
    });

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("refuses a Claw trust check without the selected artifact identity", async () => {
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      fetchImpl: async () => securityResponse("claw"),
    });

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("matches the npm shasum when the selected artifact provides one", async () => {
    const selectedArtifact = { ...expectedClawArtifact, npmShasum: "a".repeat(40) };
    const matching = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact: selectedArtifact,
      fetchImpl: async () =>
        securityResponse("claw", false, "benign", {}, { npmShasum: selectedArtifact.npmShasum }),
    });
    const mismatched = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact: selectedArtifact,
      fetchImpl: async () =>
        securityResponse("claw", false, "benign", {}, { npmShasum: "b".repeat(40) }),
    });

    expect(matching.ok).toBe(true);
    expect(mismatched).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it.each([
    ["missing artifact kind", { artifactKind: null }],
    ["different artifact kind", { artifactKind: "legacy-zip" }],
    ["missing digest", { artifactSha256: null }],
    ["missing npm integrity", { npmIntegrity: null }],
    ["different npm integrity", { npmIntegrity: "sha512-other" }],
  ] as const)("refuses %s in a Claw security report", async (_name, releaseOverrides) => {
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      fetchImpl: async () => securityResponse("claw", false, "benign", {}, releaseOverrides),
    });

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("rejects a security report for a different package family", async () => {
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      fetchImpl: async () => securityResponse("code-plugin"),
    });

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("passes the exact warning to an install consent callback before download", async () => {
    let observedWarning: string | undefined;
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      fetchImpl: async () => securityResponse("claw", true),
      confirmInstall: (warning) => {
        observedWarning = warning;
        return false;
      },
    });

    expect(result).toMatchObject({ ok: false, error: "Install cancelled." });
    expect(observedWarning).toBeTruthy();
    expect(observedWarning).toBe(result.warning);
  });

  it.each([
    ["review", "review-required"],
    ["suspicious", "review-required"],
    ["warn", "review-required"],
    ["pending", "review-required"],
    ["unknown", "review-required"],
    [null, "review-required"],
    ["malicious", "blocked"],
    ["blocked", "blocked"],
  ] as const)(
    "does not call a clean trust scan Safe when the aggregate verdict is %s",
    async (verdict, disposition) => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const result = await checkClawHubPackageTrust({
        subject,
        version,
        expectedClawArtifact,
        fetchImpl: async () => securityResponse("claw", false, verdict),
        logger,
      });

      if (disposition === "blocked") {
        expect(result).toMatchObject({ ok: false, code: "clawhub_download_blocked" });
        expect(result.warning).toContain("Outcome: Blocked");
      } else {
        expect(result).toMatchObject({
          ok: true,
          trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
        });
        expect(result.warning).toContain("Outcome: Review");
      }
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "stale"] as const)(
    "requires Claw Add acknowledgement when publisher trust is %s despite a clean aggregate verdict",
    async (state) => {
      const result = await checkClawHubPackageTrust({
        subject,
        version,
        expectedClawArtifact,
        fetchImpl: async () =>
          securityResponse("claw", false, "benign", {
            scanStatus: state,
            reasons: [`scan:${state}`],
            [state]: true,
          }),
      });

      expect(result).toMatchObject({
        ok: true,
        trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
      });
      expect(result.warning).toContain("Outcome: Review");
    },
  );
});
