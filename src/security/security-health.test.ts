import { describe, it, expect, vi, beforeEach } from "vitest";
import * as credentialAuditMod from "./credential-audit.js";
import * as credentialVaultMod from "./credential-vault.js";
import * as monitorRunnerMod from "./monitor-runner.js";
import * as securityEventsMod from "./security-events.js";
import { getSecurityHealthReport, formatHealthSummary } from "./security-health.js";
import * as sessionMonitoringMod from "./session-monitoring.js";

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock("./credential-vault.js");
vi.mock("./credential-audit.js");
vi.mock("./monitor-runner.js");
vi.mock("./security-events.js");
vi.mock("./session-monitoring.js");

// Typed refs to mock functions
const mockListCredentials = vi.mocked(credentialVaultMod.listCredentials);
const mockGetCredentialsDueForRotation = vi.mocked(credentialVaultMod.getCredentialsDueForRotation);
const mockVerifyAuditLogIntegrity = vi.mocked(credentialAuditMod.verifyAuditLogIntegrity);
const mockGetAuditStats = vi.mocked(credentialAuditMod.getAuditStats);
const mockGetMonitorRunner = vi.mocked(monitorRunnerMod.getMonitorRunner);
const mockGetSecurityEventsManager = vi.mocked(securityEventsMod.getSecurityEventsManager);
const mockQuerySecurityEvents = vi.mocked(securityEventsMod.querySecurityEvents);
const mockGetSessionRiskMonitor = vi.mocked(sessionMonitoringMod.getSessionRiskMonitor);

// ── default setup ─────────────────────────────────────────────────────────────

function applyDefaultMocks(): void {
  mockListCredentials.mockReturnValue([]);
  mockGetCredentialsDueForRotation.mockReturnValue([]);
  mockVerifyAuditLogIntegrity.mockReturnValue({ valid: true, entryCount: 0 });
  mockGetAuditStats.mockReturnValue({
    totalEntries: 0,
    byAction: { read: 0, write: 0, rotate: 0, delete: 0, list: 0 },
    byScope: { provider: 0, channel: 0, integration: 0, internal: 0 },
    successRate: 1,
    uniqueRequestors: 0,
    uniqueCredentials: 0,
  });
  mockGetMonitorRunner.mockReturnValue({
    getStatus: vi.fn().mockReturnValue({
      running: true,
      enabled: true,
      scanCount: 0,
      errorCount: 0,
      lastScanAt: null,
      nextScanAt: null,
      lastScanFindings: 0,
    }),
  } as unknown as ReturnType<typeof monitorRunnerMod.getMonitorRunner>);
  mockGetSecurityEventsManager.mockReturnValue({
    getStats: vi.fn().mockReturnValue({
      total: 0,
      bySeverity: { info: 0, warn: 0, critical: 0 },
      byType: {},
    }),
  } as unknown as ReturnType<typeof securityEventsMod.getSecurityEventsManager>);
  mockQuerySecurityEvents.mockReturnValue([]);
  mockGetSessionRiskMonitor.mockReturnValue({
    getStats: vi.fn().mockReturnValue({
      totalSessions: 0,
      highRiskCount: 0,
      averageScore: 0,
      maxScore: 0,
    }),
  } as unknown as ReturnType<typeof sessionMonitoringMod.getSessionRiskMonitor>);
}

beforeEach(() => {
  vi.resetAllMocks();
  applyDefaultMocks();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCredential(name: string): credentialVaultMod.CredentialEntry {
  return {
    name,
    scope: "provider",
    createdAt: 0,
    rotatedAt: 0,
    accessCount: 0,
    lastAccessedAt: null,
    lastAccessedBy: null,
    hashPrefix: "abc",
  };
}

function makeSecurityEvent(
  type: securityEventsMod.SecurityEventType,
  severity: securityEventsMod.SecurityEventSeverity,
): securityEventsMod.SecurityEvent {
  return {
    id: `${type}-1`,
    type,
    severity,
    source: "test",
    message: `${type} detected`,
    ts: Date.now(),
    occurrences: 1,
    details: {},
    fingerprint: `${type}-fp`,
    firstOccurrence: Date.now(),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("getSecurityHealthReport", () => {
  it("returns overall good when all subsystems are healthy", async () => {
    const report = await getSecurityHealthReport();

    expect(report.overall).toBe("good");
    expect(report.vault.status).toBe("good");
    expect(report.monitoring.status).toBe("good");
    expect(report.injectionDefense.status).toBe("good");
  });

  it("includes a generatedAt timestamp", async () => {
    const before = Date.now();
    const report = await getSecurityHealthReport();
    const after = Date.now();

    expect(report.generatedAt).toBeGreaterThanOrEqual(before);
    expect(report.generatedAt).toBeLessThanOrEqual(after);
  });

  // ── vault health ────────────────────────────────────────────────────────────

  describe("vault health", () => {
    it("returns warn when credentials are due for rotation", async () => {
      const cred = makeCredential("key1");
      mockListCredentials.mockReturnValue([cred]);
      mockGetCredentialsDueForRotation.mockReturnValue([cred]);

      const report = await getSecurityHealthReport();

      expect(report.vault.status).toBe("warn");
      expect(report.vault.rotationDueCount).toBe(1);
      expect(report.vault.credentialCount).toBe(1);
    });

    it("returns critical when audit log integrity is broken", async () => {
      mockVerifyAuditLogIntegrity.mockReturnValue({
        valid: false,
        brokenAt: Date.now() - 1000,
        reason: "hash mismatch",
        entryIndex: 5,
      });

      const report = await getSecurityHealthReport();

      expect(report.vault.status).toBe("critical");
      expect(report.vault.auditIntegrityOk).toBe(false);
      expect(report.overall).toBe("critical");
    });

    it("reports audit entry count from integrity result when valid", async () => {
      mockVerifyAuditLogIntegrity.mockReturnValue({ valid: true, entryCount: 42 });

      const report = await getSecurityHealthReport();

      expect(report.vault.auditEntryCount).toBe(42);
    });

    it("falls back to getAuditStats entryCount when integrity is broken", async () => {
      mockVerifyAuditLogIntegrity.mockReturnValue({
        valid: false,
        brokenAt: 0,
        reason: "hash mismatch",
        entryIndex: 3,
      });
      mockGetAuditStats.mockReturnValue({
        totalEntries: 17,
        byAction: { read: 0, write: 0, rotate: 0, delete: 0, list: 0 },
        byScope: { provider: 0, channel: 0, integration: 0, internal: 0 },
        successRate: 1,
        uniqueRequestors: 0,
        uniqueCredentials: 0,
      });

      const report = await getSecurityHealthReport();

      expect(report.vault.auditEntryCount).toBe(17);
    });

    it("returns warn (not good) when vault module throws", async () => {
      mockListCredentials.mockImplementation(() => {
        throw new Error("vault unavailable");
      });

      const report = await getSecurityHealthReport();

      // Fail-open was a security bug (C-02): query failure must surface as warn
      expect(report.vault.status).toBe("warn");
      expect(report.vault.auditIntegrityOk).toBe(false);
      expect(report.vault.credentialCount).toBe(0);
    });
  });

  // ── monitoring health ───────────────────────────────────────────────────────

  describe("monitoring health", () => {
    it("returns critical when critical events are present", async () => {
      mockGetSecurityEventsManager.mockReturnValue({
        getStats: vi.fn().mockReturnValue({
          total: 3,
          bySeverity: { info: 1, warn: 1, critical: 1 },
          byType: {},
        }),
      } as unknown as ReturnType<typeof securityEventsMod.getSecurityEventsManager>);
      mockQuerySecurityEvents.mockReturnValue([
        makeSecurityEvent("container_escape_attempt", "critical"),
      ]);

      const report = await getSecurityHealthReport();

      expect(report.monitoring.status).toBe("critical");
      expect(report.monitoring.criticalEvents).toBe(1);
      expect(report.monitoring.recentCriticalAlerts).toHaveLength(1);
      expect(report.overall).toBe("critical");
    });

    it("returns warn when monitor runner is not running", async () => {
      mockGetMonitorRunner.mockReturnValue({
        getStatus: vi.fn().mockReturnValue({
          running: false,
          enabled: false,
          scanCount: 0,
          errorCount: 0,
          lastScanAt: null,
          nextScanAt: null,
          lastScanFindings: 0,
        }),
      } as unknown as ReturnType<typeof monitorRunnerMod.getMonitorRunner>);

      const report = await getSecurityHealthReport();

      expect(report.monitoring.status).toBe("warn");
      expect(report.monitoring.runnerRunning).toBe(false);
    });

    it("returns warn when high-risk sessions exist", async () => {
      mockGetSessionRiskMonitor.mockReturnValue({
        getStats: vi.fn().mockReturnValue({
          totalSessions: 2,
          highRiskCount: 1,
          averageScore: 85,
          maxScore: 120,
        }),
      } as unknown as ReturnType<typeof sessionMonitoringMod.getSessionRiskMonitor>);

      const report = await getSecurityHealthReport();

      expect(report.monitoring.status).toBe("warn");
      expect(report.monitoring.highRiskSessions).toBe(1);
    });

    it("returns warn (not good) when monitoring module throws", async () => {
      mockGetMonitorRunner.mockImplementation(() => {
        throw new Error("not initialized");
      });

      const report = await getSecurityHealthReport();

      // Fail-open was a security bug (C-02): query failure must surface as warn
      expect(report.monitoring.status).toBe("warn");
      expect(report.monitoring.runnerRunning).toBe(false);
    });
  });

  // ── injection defense health ────────────────────────────────────────────────

  describe("injection defense health", () => {
    it("returns good when no injection events exist", async () => {
      const report = await getSecurityHealthReport();

      expect(report.injectionDefense.status).toBe("good");
      expect(report.injectionDefense.recentDetections).toBe(0);
      expect(report.injectionDefense.criticalDetections).toBe(0);
    });

    it("returns critical when critical injection events are detected", async () => {
      // querySecurityEvents is called concurrently: once in monitoring (severity:"critical"),
      // once in injection defense (no severity filter). Use implementation to distinguish.
      mockQuerySecurityEvents.mockImplementation(
        (filters?: securityEventsMod.SecurityEventQueryFilters) => {
          if (filters?.severity === "critical") {
            return []; // monitoring: recent critical alert list
          }
          return [makeSecurityEvent("injection_detected", "critical")];
        },
      );

      const report = await getSecurityHealthReport();

      expect(report.injectionDefense.status).toBe("critical"); // AR-5: critical detections → critical status
      expect(report.injectionDefense.criticalDetections).toBe(1);
    });

    it("returns warn when only non-critical injection events are detected", async () => {
      mockQuerySecurityEvents.mockImplementation(
        (filters?: securityEventsMod.SecurityEventQueryFilters) => {
          if (filters?.severity === "critical") {
            return [];
          }
          return [makeSecurityEvent("injection_detected", "warn")];
        },
      );

      const report = await getSecurityHealthReport();

      // warn-severity injections do not escalate to critical (AR-5)
      expect(report.injectionDefense.status).toBe("warn");
      expect(report.injectionDefense.recentDetections).toBe(1);
      expect(report.injectionDefense.criticalDetections).toBe(0);
    });

    it("counts only injection_detected events, not other types", async () => {
      mockQuerySecurityEvents.mockImplementation(
        (filters?: securityEventsMod.SecurityEventQueryFilters) => {
          if (filters?.severity === "critical") {
            return [];
          }
          return [
            makeSecurityEvent("injection_detected", "warn"),
            makeSecurityEvent("credential_access_spike", "warn"), // should not count
            makeSecurityEvent("injection_detected", "critical"),
          ];
        },
      );

      const report = await getSecurityHealthReport();

      expect(report.injectionDefense.recentDetections).toBe(2);
      expect(report.injectionDefense.criticalDetections).toBe(1);
    });

    it("returns warn (not good) when events module throws", async () => {
      mockQuerySecurityEvents.mockImplementation(() => {
        throw new Error("events not ready");
      });
      mockGetSecurityEventsManager.mockImplementation(() => {
        throw new Error("events not ready");
      });

      const report = await getSecurityHealthReport();

      // Fail-open was a security bug (C-02): query failure must surface as warn
      expect(report.injectionDefense.status).toBe("warn");
    });
  });

  // ── overall escalation ──────────────────────────────────────────────────────

  describe("overall status escalation", () => {
    it("escalates to critical if vault is critical", async () => {
      mockVerifyAuditLogIntegrity.mockReturnValue({
        valid: false,
        brokenAt: 0,
        reason: "hash mismatch",
        entryIndex: 1,
      });

      const report = await getSecurityHealthReport();

      expect(report.overall).toBe("critical");
    });

    it("escalates to warn if vault has rotation due but nothing is critical", async () => {
      mockGetCredentialsDueForRotation.mockReturnValue([makeCredential("old-key")]);

      const report = await getSecurityHealthReport();

      expect(report.overall).toBe("warn");
    });

    it("escalates to warn if runner is stopped", async () => {
      mockGetMonitorRunner.mockReturnValue({
        getStatus: vi.fn().mockReturnValue({
          running: false,
          enabled: false,
          scanCount: 0,
          errorCount: 0,
          lastScanAt: null,
          nextScanAt: null,
          lastScanFindings: 0,
        }),
      } as unknown as ReturnType<typeof monitorRunnerMod.getMonitorRunner>);

      const report = await getSecurityHealthReport();

      expect(report.overall).toBe("warn");
    });

    it("critical takes priority over warn", async () => {
      mockGetCredentialsDueForRotation.mockReturnValue([makeCredential("old-key")]);
      mockVerifyAuditLogIntegrity.mockReturnValue({
        valid: false,
        brokenAt: 0,
        reason: "hash mismatch",
        entryIndex: 1,
      });

      const report = await getSecurityHealthReport();

      expect(report.overall).toBe("critical");
    });
  });
});

// ── formatHealthSummary ───────────────────────────────────────────────────────

describe("formatHealthSummary", () => {
  const baseReport = {
    overall: "good" as const,
    vault: {
      credentialCount: 3,
      rotationDueCount: 0,
      auditIntegrityOk: true,
      auditEntryCount: 10,
      status: "good" as const,
    },
    monitoring: {
      runnerRunning: true,
      totalEvents: 5,
      criticalEvents: 0,
      warnEvents: 2,
      highRiskSessions: 0,
      recentCriticalAlerts: [],
      status: "good" as const,
    },
    injectionDefense: {
      recentDetections: 0,
      criticalDetections: 0,
      status: "good" as const,
    },
    generatedAt: Date.now(),
  };

  it("formats a good report correctly", () => {
    const summary = formatHealthSummary(baseReport);

    expect(summary).toContain("GOOD");
    expect(summary).toContain("3 credentials");
    expect(summary).toContain("0 critical events");
    expect(summary).toContain("0 injections (24h)");
  });

  it("uses singular forms for counts of 1", () => {
    const report = {
      ...baseReport,
      vault: { ...baseReport.vault, credentialCount: 1 },
      monitoring: { ...baseReport.monitoring, criticalEvents: 1 },
      injectionDefense: { ...baseReport.injectionDefense, recentDetections: 1 },
    };

    const summary = formatHealthSummary(report);

    expect(summary).toContain("1 credential ");
    expect(summary).toContain("1 critical event ");
    expect(summary).toContain("1 injection (24h)");
  });

  it("uses plural forms for counts of 0 and 2+", () => {
    const report = {
      ...baseReport,
      vault: { ...baseReport.vault, credentialCount: 2 },
      monitoring: { ...baseReport.monitoring, criticalEvents: 2 },
      injectionDefense: { ...baseReport.injectionDefense, recentDetections: 2 },
    };

    const summary = formatHealthSummary(report);

    expect(summary).toContain("2 credentials");
    expect(summary).toContain("2 critical events");
    expect(summary).toContain("2 injections (24h)");
  });

  it("includes overall status at the start", () => {
    const warnReport = { ...baseReport, overall: "warn" as const };
    expect(formatHealthSummary(warnReport)).toContain("WARN");

    const critReport = { ...baseReport, overall: "critical" as const };
    expect(formatHealthSummary(critReport)).toContain("CRITICAL");
  });
});
