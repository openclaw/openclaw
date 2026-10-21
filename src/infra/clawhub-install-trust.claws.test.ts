import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClawHubPackageTrust } from "./clawhub-install-trust.js";

const subject = { kind: "claw" as const, packageName: "@openclaw/research-briefing" };
const version = "1.0.0";
const expectedClawArtifact = {
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
    expectedClawArtifact,
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
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ClawHub Claw trust", () => {
  it("checks the exact Claw release through the current package security route", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return securityResponse("claw");
    });
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      expectedClawArtifact,
      baseUrl: "https://clawhub.example",
    });

    expect(result).toMatchObject({
      ok: true,
      trustInstallRecordFields: { clawhubTrustDisposition: "clean" },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fresearch-briefing/versions/1.0.0/security",
    );
  });

  it.each([true, false])("matches the selected npm shasum: %s", async (matches) => {
    const selectedArtifact = { ...expectedClawArtifact, npmShasum: "a".repeat(40) };
    const npmShasum = (matches ? "a" : "b").repeat(40);
    const result = await check(securityResponse("claw", false, "benign", {}, { npmShasum }), {
      expectedClawArtifact: selectedArtifact,
    });
    expect(result).toMatchObject(
      matches ? { ok: true } : { ok: false, code: "clawhub_security_unavailable" },
    );
  });

  it.each([
    ["different digest", { artifactSha256: "b".repeat(64) }],
    ["missing artifact kind", { artifactKind: null }],
    ["different artifact kind", { artifactKind: "legacy-zip" }],
    ["missing digest", { artifactSha256: null }],
    ["missing npm integrity", { npmIntegrity: null }],
    ["different npm integrity", { npmIntegrity: "sha512-other" }],
  ] as const)("refuses %s in a Claw security report", async (_name, releaseOverrides) => {
    const result = await check(securityResponse("claw", false, "benign", {}, releaseOverrides));

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it.each([
    ["different package family", "code-plugin", {}],
    ["missing selected artifact", "claw", { expectedClawArtifact: undefined }],
  ] as const)("refuses %s", async (_label, family, options) => {
    await expect(check(securityResponse(family), options)).resolves.toMatchObject({
      ok: false,
      code: "clawhub_security_unavailable",
    });
  });

  it("passes the exact warning to an install consent callback before download", async () => {
    let observedWarning: string | undefined;
    const result = await check(securityResponse("claw", true), {
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
    const result = await check(securityResponse("claw", false, verdict, trust), { logger });
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
