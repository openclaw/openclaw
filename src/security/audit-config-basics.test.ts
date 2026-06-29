// Covers baseline config security audit findings.
import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { collectElevatedFindings, runSecurityAudit } from "./audit.js";

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

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
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "security.audit.suppressions.active",
          severity: "info",
        }),
      ]),
    );
    expect(report.suppressedFindings).toEqual([
      expect.objectContaining({
        checkId: "gateway.trusted_proxies_missing",
        suppression: { reason: "loopback-only local development" },
      }),
    ]);
    expect(report.summary.warn).toBe(report.findings.filter((f) => f.severity === "warn").length);
  });

  it("keeps unrelated dangerous flags active when one dangerous flag is suppressed", async () => {
    const report = await runSecurityAudit({
      config: {
        gateway: {
          controlUi: { allowInsecureAuth: true },
        },
        tools: {
          exec: {
            applyPatch: { workspaceOnly: false },
          },
        },
        security: {
          audit: {
            suppressions: [
              {
                checkId: "config.insecure_or_dangerous_flags",
                detailIncludes: "gateway.controlUi.allowInsecureAuth=true",
                reason: "accepted local-only browser auth testing",
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

    expect(report.suppressedFindings).toEqual([
      expect.objectContaining({
        checkId: "config.insecure_or_dangerous_flags",
        detail: expect.stringContaining("gateway.controlUi.allowInsecureAuth=true"),
      }),
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "config.insecure_or_dangerous_flags",
          detail: expect.stringContaining("tools.exec.applyPatch.workspaceOnly=false"),
        }),
        expect.objectContaining({
          checkId: "security.audit.suppressions.active",
        }),
      ]),
    );
  });

  it("does not flag gateway password or hooks token when source config uses env references", async () => {
    const report = await runSecurityAudit({
      config: {
        gateway: {
          auth: { password: "actual-resolved-password" },
        },
        hooks: { enabled: true, token: "actual-resolved-token" },
      },
      sourceConfig: {
        gateway: {
          auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" },
        },
        hooks: { enabled: true, token: "${OPENCLAW_HOOKS_TOKEN}" },
      },
      configSnapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: '{"gateway":{"auth":{"password":"${OPENCLAW_GATEWAY_PASSWORD}"}},"hooks":{"enabled":true,"token":"${OPENCLAW_HOOKS_TOKEN}"}}',
        parsed: {
          gateway: {
            auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" },
          },
          hooks: { enabled: true, token: "${OPENCLAW_HOOKS_TOKEN}" },
        },
        sourceConfig: {
          gateway: {
            auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" },
          },
          hooks: { enabled: true, token: "${OPENCLAW_HOOKS_TOKEN}" },
        },
        resolved: {
          gateway: {
            auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" },
          },
          hooks: { enabled: true, token: "${OPENCLAW_HOOKS_TOKEN}" },
        },
        valid: true,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      report.findings.some((f) => f.checkId === "config.secrets.gateway_password_in_config"),
    ).toBe(false);
    expect(report.findings.some((f) => f.checkId === "config.secrets.hooks_token_in_config")).toBe(
      false,
    );
  });

  it("still flags gateway password and hooks token stored as plaintext literals", async () => {
    const report = await runSecurityAudit({
      config: {
        gateway: {
          auth: { password: "literal-password" },
        },
        hooks: { enabled: true, token: "literal-token" },
      },
      sourceConfig: {
        gateway: {
          auth: { password: "literal-password" },
        },
        hooks: { enabled: true, token: "literal-token" },
      },
      configSnapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: '{"gateway":{"auth":{"password":"literal-password"}},"hooks":{"enabled":true,"token":"literal-token"}}',
        parsed: {
          gateway: {
            auth: { password: "literal-password" },
          },
          hooks: { enabled: true, token: "literal-token" },
        },
        sourceConfig: {
          gateway: {
            auth: { password: "literal-password" },
          },
          hooks: { enabled: true, token: "literal-token" },
        },
        resolved: {
          gateway: {
            auth: { password: "literal-password" },
          },
          hooks: { enabled: true, token: "literal-token" },
        },
        valid: true,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      report.findings.some(
        (f) => f.checkId === "config.secrets.gateway_password_in_config" && f.severity === "warn",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) => f.checkId === "config.secrets.hooks_token_in_config" && f.severity === "info",
      ),
    ).toBe(true);
  });

  it("emits a redacted security audit summary event", async () => {
    resetDiagnosticEventsForTest();
    const captured = captureSecurityEvents();

    let report: Awaited<ReturnType<typeof runSecurityAudit>>;
    try {
      report = await runSecurityAudit({
        config: {
          logging: {
            redactSensitive: "off",
          },
        },
        sourceConfig: {},
        env: {},
        includeFilesystem: false,
        includeChannelSecurity: false,
      });
    } finally {
      captured.stop();
    }

    expect(report!.summary.warn).toBeGreaterThan(0);
    const expectedSeverity = report!.summary.critical > 0 ? "critical" : "medium";
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      category: "audit",
      action: "security.audit.completed",
      outcome: "failure",
      severity: expectedSeverity,
      actor: { kind: "operator" },
      target: { kind: "config", name: "security.audit" },
      policy: { id: "security.audit", decision: "not_applicable" },
      control: { id: "security.audit", family: "authorization" },
      attributes: {
        critical_count: report!.summary.critical,
        warn_count: report!.summary.warn,
        info_count: report!.summary.info,
        suppressed_count: 0,
        deep: false,
        include_filesystem: false,
        include_channel_security: false,
      },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("redactSensitive");
    expect(serialized).not.toContain("logs and status output");
  });
});
