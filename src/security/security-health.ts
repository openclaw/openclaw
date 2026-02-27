/**
 * Security posture aggregator for OpenClaw.
 *
 * Bridges Phase 4 (injection defense), Phase 5 (credential protection), and
 * Phase 6 (monitoring & detection) into a single health snapshot.
 *
 * Used by `openclaw security health` and `openclaw doctor`.
 *
 * All subsystem queries are wrapped in try/catch — the report always returns
 * even if subsystems have not been initialized (e.g. standalone CLI invocation
 * outside the gateway process).
 */

// ── types ─────────────────────────────────────────────────────────────────────

export type HealthStatus = "good" | "warn" | "critical";

export type VaultHealth = {
  /** Number of stored credentials. */
  credentialCount: number;
  /** Number of credentials past their rotation window. */
  rotationDueCount: number;
  /** Whether the audit log hash chain is intact. */
  auditIntegrityOk: boolean;
  /** Total entries in the audit log. */
  auditEntryCount: number;
  /** Aggregated status for this subsystem. */
  status: HealthStatus;
};

export type MonitoringHealth = {
  /** Whether the MonitorRunner is actively running scheduled scans. */
  runnerRunning: boolean;
  /** Total security events in the in-memory ring buffer. */
  totalEvents: number;
  /** Critical-severity events in the ring buffer. */
  criticalEvents: number;
  /** Warn-severity events in the ring buffer. */
  warnEvents: number;
  /** Sessions currently above the high-risk threshold. */
  highRiskSessions: number;
  /** Short descriptions of the most recent critical events (up to 5). */
  recentCriticalAlerts: string[];
  /** Aggregated status for this subsystem. */
  status: HealthStatus;
};

export type InjectionDefenseHealth = {
  /**
   * Injection-detection events recorded in the last 24 hours.
   * Populated once safe-file-read emits events into the Phase 6 system.
   */
  recentDetections: number;
  /** Critical-risk injections detected in the last 24 hours. */
  criticalDetections: number;
  /** Aggregated status for this subsystem. */
  status: HealthStatus;
};

export type SecurityHealthReport = {
  /** Worst-case status across all subsystems. */
  overall: HealthStatus;
  vault: VaultHealth;
  monitoring: MonitoringHealth;
  injectionDefense: InjectionDefenseHealth;
  /** Unix timestamp (ms) when this report was generated. */
  generatedAt: number;
};

// ── helpers ───────────────────────────────────────────────────────────────────

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("critical")) {
    return "critical";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  return "good";
}

// ── subsystem queries ─────────────────────────────────────────────────────────

async function queryVaultHealth(): Promise<VaultHealth> {
  try {
    const [vaultMod, auditMod] = await Promise.all([
      import("./credential-vault.js"),
      import("./credential-audit.js"),
    ]);

    const credentials = vaultMod.listCredentials();
    const rotationDue = vaultMod.getCredentialsDueForRotation();
    const integrity = auditMod.verifyAuditLogIntegrity();
    const auditStats = auditMod.getAuditStats();

    const credentialCount = credentials.length;
    const rotationDueCount = rotationDue.length;
    const auditIntegrityOk = integrity.valid;
    const auditEntryCount = integrity.valid ? integrity.entryCount : auditStats.totalEntries;

    let status: HealthStatus = "good";
    if (!auditIntegrityOk) {
      status = "critical";
    } else if (rotationDueCount > 0) {
      status = "warn";
    }

    return { credentialCount, rotationDueCount, auditIntegrityOk, auditEntryCount, status };
  } catch {
    // Return warn (not good) so callers can distinguish "healthy" from "query failed"
    return {
      credentialCount: 0,
      rotationDueCount: 0,
      auditIntegrityOk: false,
      auditEntryCount: 0,
      status: "warn",
    };
  }
}

async function queryMonitoringHealth(): Promise<MonitoringHealth> {
  try {
    const [runnerMod, eventsMod, sessionMod] = await Promise.all([
      import("./monitor-runner.js"),
      import("./security-events.js"),
      import("./session-monitoring.js"),
    ]);

    const runnerStatus = runnerMod.getMonitorRunner().getStatus();
    const eventsStats = eventsMod.getSecurityEventsManager().getStats();
    const sessionStats = sessionMod.getSessionRiskMonitor().getStats();

    const recentCritical = eventsMod.querySecurityEvents({
      severity: "critical",
      since: Date.now() - 24 * 60 * 60 * 1000,
      limit: 5,
    });
    const recentCriticalAlerts = recentCritical.map((ev) => `${ev.type}: ${ev.message}`);

    let status: HealthStatus = "good";
    if (eventsStats.bySeverity.critical > 0) {
      status = "critical";
    } else if (
      !runnerStatus.running ||
      sessionStats.highRiskCount > 0 ||
      eventsStats.bySeverity.warn > 5
    ) {
      status = "warn";
    }

    return {
      runnerRunning: runnerStatus.running,
      totalEvents: eventsStats.total,
      criticalEvents: eventsStats.bySeverity.critical,
      warnEvents: eventsStats.bySeverity.warn,
      highRiskSessions: sessionStats.highRiskCount,
      recentCriticalAlerts,
      status,
    };
  } catch {
    // Return warn (not good) so callers can distinguish "healthy" from "query failed"
    return {
      runnerRunning: false,
      totalEvents: 0,
      criticalEvents: 0,
      warnEvents: 0,
      highRiskSessions: 0,
      recentCriticalAlerts: [],
      status: "warn",
    };
  }
}

/**
 * Query Phase 4 injection-defense health for the last 24 hours.
 *
 * **Status semantics (DC-4):**
 * - `"critical"` — one or more `critical`-severity injection events detected.
 *   This indicates a likely active attack attempt and should trigger immediate
 *   operator review.  Previously returned `"warn"` (AR-5 regression), which
 *   under-represented the signal; corrected in Sprint 6.
 * - `"warn"` — non-critical injection events detected but no critical ones.
 *   Suspicious content was blocked but no confirmed high-severity indicator.
 * - `"good"` — no injection events in the last 24 hours.
 *
 * On error (e.g. events manager not yet initialised), returns `status: "warn"`
 * with zero counts so callers can distinguish an uninitialised subsystem from
 * a genuinely healthy one.
 */
async function queryInjectionDefenseHealth(): Promise<InjectionDefenseHealth> {
  try {
    const { querySecurityEvents } = await import("./security-events.js");

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const injectionEvents = querySecurityEvents({
      since,
      limit: 200,
    }).filter((ev) => ev.type === "injection_detected");

    const recentDetections = injectionEvents.length;
    const criticalDetections = injectionEvents.filter((ev) => ev.severity === "critical").length;

    let status: HealthStatus = "good";
    if (criticalDetections > 0) {
      // Critical-severity injection events warrant "critical" posture (AR-5).
      // Previously returned "warn", which under-represented active attack signals.
      status = "critical";
    } else if (recentDetections > 0) {
      status = "warn";
    }

    return { recentDetections, criticalDetections, status };
  } catch {
    // Return warn (not good) so callers can distinguish "healthy" from "query failed"
    return { recentDetections: 0, criticalDetections: 0, status: "warn" };
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Generate a full security posture report by querying all subsystems.
 *
 * Always resolves — individual subsystem failures are caught and reported as
 * `status: "warn"` with safe zero values so callers can distinguish an
 * uninitialised subsystem from a genuinely healthy one.
 *
 * @example
 * ```ts
 * const report = await getSecurityHealthReport();
 * if (report.overall === "critical") {
 *   console.error("Security issues detected:", report.monitoring.recentCriticalAlerts);
 * }
 * ```
 */
export async function getSecurityHealthReport(): Promise<SecurityHealthReport> {
  const [vault, monitoring, injectionDefense] = await Promise.all([
    queryVaultHealth(),
    queryMonitoringHealth(),
    queryInjectionDefenseHealth(),
  ]);

  const overall = worstStatus([vault.status, monitoring.status, injectionDefense.status]);

  return { overall, vault, monitoring, injectionDefense, generatedAt: Date.now() };
}

/**
 * Returns a one-line summary suitable for inline display (e.g. doctor header).
 *
 * @example "GOOD  — 3 credentials · 0 critical events · 0 injections (24h)"
 */
export function formatHealthSummary(report: SecurityHealthReport): string {
  const statusLabel = report.overall.toUpperCase().padEnd(8);
  const creds = `${report.vault.credentialCount} credential${report.vault.credentialCount === 1 ? "" : "s"}`;
  const critEvents = `${report.monitoring.criticalEvents} critical event${report.monitoring.criticalEvents === 1 ? "" : "s"}`;
  const injections = `${report.injectionDefense.recentDetections} injection${report.injectionDefense.recentDetections === 1 ? "" : "s"} (24h)`;
  return `${statusLabel}— ${creds} · ${critEvents} · ${injections}`;
}
