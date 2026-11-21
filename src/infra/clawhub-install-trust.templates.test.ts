import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClawHubPackageTrust } from "./clawhub-install-trust.js";
import { captureClawHubResponse } from "./clawhub.test-support.js";

const subject = { kind: "template" as const, packageName: "@openclaw/research-briefing" };
const version = "1.0.0";
const expectedTemplateArtifact = {
  sha256: "a".repeat(64),
  npmIntegrity: "sha512-proof",
};

function check(
  response: Response,
  options: Partial<Parameters<typeof checkClawHubPackageTrust>[0]> = {},
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
  return checkClawHubPackageTrust({
    subject,
    version,
    expectedTemplateArtifact,
    ...options,
  });
}

function securityResponse(
  family: string,
  warned = false,
  verdict: string | null = "benign",
  trustOverrides: Record<string, unknown> = {},
  releaseOverrides: Record<string, unknown> = {},
) {
  return Response.json({
    package: { name: subject.packageName, displayName: "Research Briefing", family },
    release: {
      version,
      artifactKind: "npm-pack",
      artifactSha256: expectedTemplateArtifact.sha256,
      npmIntegrity: expectedTemplateArtifact.npmIntegrity,
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
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ClawHub Template trust", () => {
  it("checks the exact Template release through the current package security route", async () => {
    const request = captureClawHubResponse(() => securityResponse("template"));
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedTemplateArtifact,
      baseUrl: "https://clawhub.example",
    });

    expect(result).toMatchObject({
      ok: true,
      trustInstallRecordFields: { clawhubTrustDisposition: "clean" },
    });
    expect(request.url().pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fresearch-briefing/versions/1.0.0/security",
    );
  });

  it.each([true, false])("matches the selected npm shasum: %s", async (matches) => {
    const selectedArtifact = { ...expectedTemplateArtifact, npmShasum: "a".repeat(40) };
    const npmShasum = (matches ? "a" : "b").repeat(40);
    const result = await check(securityResponse("template", false, "benign", {}, { npmShasum }), {
      expectedTemplateArtifact: selectedArtifact,
    });
    expect(result).toMatchObject(
      matches ? { ok: true } : { ok: false, code: "clawhub_security_unavailable" },
    );
  });

  it.each([
    ["different digest", "template", { artifactSha256: "b".repeat(64) }, {}],
    ["missing artifact kind", "template", { artifactKind: null }, {}],
    ["different artifact kind", "template", { artifactKind: "legacy-zip" }, {}],
    ["missing digest", "template", { artifactSha256: null }, {}],
    ["missing npm integrity", "template", { npmIntegrity: null }, {}],
    ["different npm integrity", "template", { npmIntegrity: "sha512-other" }, {}],
    ["different package family", "code-plugin", {}, {}],
    ["missing selected artifact", "template", {}, { expectedTemplateArtifact: undefined }],
  ] as const)("refuses %s", async (_label, family, releaseOverrides, options) => {
    const result = await check(
      securityResponse(family, false, "benign", {}, releaseOverrides),
      options,
    );
    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("passes the exact warning to an install consent callback before download", async () => {
    let observedWarning: string | undefined;
    const result = await check(securityResponse("template", true), {
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
    ["review", undefined, false],
    ["suspicious", undefined, false],
    ["warn", undefined, false],
    ["pending", undefined, false],
    ["unknown", undefined, false],
    [null, undefined, false],
    ["malicious", undefined, true],
    ["blocked", undefined, true],
    ["benign", "pending", false],
    ["benign", "stale", false],
  ] as const)("does not call verdict %s / scan %s Safe", async (verdict, state, blocked) => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const trust = state ? { scanStatus: state, reasons: [`scan:${state}`], [state]: true } : {};
    const result = await check(securityResponse("template", false, verdict, trust), { logger });
    expect(result).toMatchObject(
      blocked
        ? { ok: false, code: "clawhub_download_blocked" }
        : {
            ok: true,
            trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
          },
    );
    expect(result.warning).toContain(`Outcome: ${blocked ? "Blocked" : "Review"}`);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
