import { describe, expect, it } from "vitest";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { collectElevatedFindings, runSecurityAudit } from "./audit.js";

describe("security audit config basics", () => {
  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: {
        profile: "minimal",
      },
      agents: {
        list: [
          {
            id: "owner",
            tools: { profile: "full" },
          },
        ],
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.profile_minimal_overridden" && finding.severity === "warn",
      ),
    ).toBe(true);
  });

  it("flags tools.elevated allowFrom wildcard as critical", () => {
    const findings = collectElevatedFindings({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.elevated.allowFrom.whatsapp.wildcard" &&
          finding.severity === "critical",
      ),
    ).toBe(true);
  });

  it("suppresses configured accepted findings from the active audit report", async () => {
    const report = await runSecurityAudit({
      config: {
        security: {
          audit: {
            suppressions: [
              {
                checkId: "gateway.trusted_proxies_missing",
                detailIncludes: "trustedProxies",
                reason: "loopback-only local development",
              },
            ],
          },
        },
      },
      sourceConfig: {},
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      report.findings.some((finding) => finding.checkId === "gateway.trusted_proxies_missing"),
    ).toBe(false);
    expect(report.suppressedFindings).toEqual([
      expect.objectContaining({
        checkId: "gateway.trusted_proxies_missing",
        suppression: { reason: "loopback-only local development" },
      }),
    ]);
    expect(report.summary.warn).toBe(report.findings.filter((f) => f.severity === "warn").length);
  });
});
