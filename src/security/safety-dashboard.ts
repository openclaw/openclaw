/**
 * Safety Dashboard
 *
 * Provides gateway methods for querying safety events, statistics,
 * and generating safety reports.
 *
 * Addresses: R-003 (P0), all threat categories (observability)
 */

import type { OpenClawPluginApi } from "../plugins/types.js";
import type { KillSwitch } from "./kill-switch.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { SafetyEventLog, SafetyEventQuery } from "./safety-event-log.js";

export type SafetyReportSection = {
  title: string;
  status: "ok" | "warning" | "critical";
  details: string;
};

export type SafetyReport = {
  timestamp: number;
  sections: SafetyReportSection[];
  summary: {
    status: "ok" | "warning" | "critical";
    message: string;
  };
};

/**
 * Register safety dashboard gateway methods.
 */
export function registerSafetyDashboard(
  api: OpenClawPluginApi,
  deps: {
    eventLog: SafetyEventLog;
    killSwitch: KillSwitch;
    rateLimiter: RateLimiter;
  },
): void {
  const { eventLog, killSwitch } = deps;

  // safety.events — query safety events
  api.registerGatewayMethod("safety.events", async (params) => {
    const query: SafetyEventQuery = {
      category: params?.category as SafetyEventQuery["category"],
      severity: params?.severity as SafetyEventQuery["severity"],
      since: typeof params?.since === "number" ? params.since : undefined,
      limit: typeof params?.limit === "number" ? params.limit : 100,
      sessionKey: typeof params?.sessionKey === "string" ? params.sessionKey : undefined,
    };
    return { events: eventLog.query(query) };
  });

  // safety.stats — get aggregate statistics
  api.registerGatewayMethod("safety.stats", async (params) => {
    const since = typeof params?.since === "number" ? params.since : undefined;
    return { stats: eventLog.getStats(since) };
  });

  // safety.report — generate a safety report
  api.registerGatewayMethod("safety.report", async () => {
    const sections: SafetyReportSection[] = [];
    const stats = eventLog.getStats(Date.now() - 24 * 60 * 60 * 1000); // Last 24h

    // Kill switch status
    const ksStatus = killSwitch.status();
    sections.push({
      title: "Kill Switch",
      status: ksStatus.active ? "critical" : "ok",
      details: ksStatus.active
        ? `Active: ${ksStatus.entries.map((e) => `${e.scope}${e.key ? `:${e.key}` : ""} - ${e.reason}`).join("; ")}`
        : "Inactive",
    });

    // Safety events summary
    const criticalCount = stats.bySeverity["critical"] ?? 0;
    const warnCount = stats.bySeverity["warn"] ?? 0;
    sections.push({
      title: "Safety Events (24h)",
      status: criticalCount > 0 ? "critical" : warnCount > 5 ? "warning" : "ok",
      details: `Total: ${stats.total}, Critical: ${criticalCount}, Warn: ${warnCount}`,
    });

    // Injection attempts
    const injectionCount = stats.byCategory["injection"] ?? 0;
    sections.push({
      title: "Injection Attempts (24h)",
      status: injectionCount > 10 ? "warning" : "ok",
      details: `Detected: ${injectionCount}`,
    });

    // Secret leaks
    const leakCount = stats.byCategory["secret-leak"] ?? 0;
    sections.push({
      title: "Secret Leak Prevention (24h)",
      status: leakCount > 0 ? "warning" : "ok",
      details: leakCount > 0 ? `Prevented: ${leakCount}` : "No leaks detected",
    });

    // Determine overall status
    const hasAnyCritical = sections.some((s) => s.status === "critical");
    const hasAnyWarning = sections.some((s) => s.status === "warning");
    const overallStatus = hasAnyCritical ? "critical" : hasAnyWarning ? "warning" : "ok";

    const report: SafetyReport = {
      timestamp: Date.now(),
      sections,
      summary: {
        status: overallStatus,
        message:
          overallStatus === "critical"
            ? "Critical safety issues detected"
            : overallStatus === "warning"
              ? "Safety warnings present"
              : "All safety systems operational",
      },
    };

    return { report };
  });

  // safety.killswitch.activate
  api.registerGatewayMethod("safety.killswitch.activate", async (params) => {
    const scope = (params?.scope as "global" | "agent" | "session") ?? "global";
    const key = typeof params?.key === "string" ? params.key : undefined;
    const reason = typeof params?.reason === "string" ? params.reason : "Manual activation";
    const entry = killSwitch.activate({ scope, key, reason });
    return { activated: true, entry };
  });

  // safety.killswitch.deactivate
  api.registerGatewayMethod("safety.killswitch.deactivate", async (params) => {
    const scope = (params?.scope as "global" | "agent" | "session") ?? "global";
    const key = typeof params?.key === "string" ? params.key : undefined;
    const deactivated = killSwitch.deactivate(scope, key);
    return { deactivated, status: killSwitch.status() };
  });

  // safety.killswitch.status
  api.registerGatewayMethod("safety.killswitch.status", async () => {
    return killSwitch.status();
  });
}
