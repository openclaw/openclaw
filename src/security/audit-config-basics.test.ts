// Covers baseline config security audit findings.
import { describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { runSecurityAuditCore } from "./audit.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

function captureSecurityEvents(): {
  events: Extract<DiagnosticEventPayload, { type: "security.event" }>[];
  stop: () => void;
} {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("security audit config basics", () => {
  it("preserves malformed roster defaults through the shared audit helper", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {}, ops: {} } },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "config.agent_roster.invalid_default_count",
        detail: expect.stringContaining("found 0"),
      }),
    );
  });

  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: {
        profile: "minimal",
      },
      agents: {
        entries: {
          owner: {
            tools: { profile: "full" },
          },
        },
      },
    });

    const finding = findings.find((entry) => entry.checkId === "tools.profile_minimal_overridden");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("agents.entries.owner=full");
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {} } },
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
    const report = await runSecurityAuditCore({
      config: {
        agents: { entries: { main: {} } },
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
    const report = await runSecurityAuditCore({
      config: {
        agents: { entries: { main: {} } },
        hooks: { gmail: { allowUnsafeExternalContent: true } },
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
                detailIncludes: "hooks.gmail.allowUnsafeExternalContent=true",
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
        detail: expect.stringContaining("hooks.gmail.allowUnsafeExternalContent=true"),
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

  it("emits a redacted security audit summary event", async () => {
    resetDiagnosticEventsForTest();
    const captured = captureSecurityEvents();

    let report: Awaited<ReturnType<typeof runSecurityAuditCore>>;
    try {
      report = await runSecurityAuditCore({
        config: { agents: { entries: { main: {} } } },
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
