import { describe, expect, it } from "vitest";
import { checkClawHubPackageTrust } from "./clawhub-install-trust.js";

const subject = { kind: "claw" as const, packageName: "@openclaw/research-briefing" };
const version = "1.0.0";

function securityResponse(family: string, warned = false) {
  return new Response(
    JSON.stringify({
      package: { name: subject.packageName, displayName: "Research Briefing", family },
      release: { version },
      overview: "No concerning capabilities found.",
      securityAuditUrl: "https://clawhub.example/audit",
      trust: {
        scanStatus: warned ? "suspicious" : "clean",
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: warned ? ["scan:suspicious"] : [],
        pending: false,
        stale: false,
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

  it("rejects a security report for a different package family", async () => {
    const result = await checkClawHubPackageTrust({
      subject,
      version,
      fetchImpl: async () => securityResponse("code-plugin"),
    });

    expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
  });

  it("passes the exact warning to an install consent callback before download", async () => {
    let observedWarning: string | undefined;
    const result = await checkClawHubPackageTrust({
      subject,
      version,
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
});
