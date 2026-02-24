/**
 * Session Monitoring - Phase 6 Security Monitoring & Detection
 *
 * Session risk scoring accumulator for tracking suspicious session behavior.
 * Lightweight with no external dependencies.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitSecurityEvent } from "./security-events.js";

const log = createSubsystemLogger("security/session-monitoring");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SessionMonitoringConfig {
  /** Whether session monitoring is enabled (default: true) */
  enabled?: boolean;
  /** Risk score threshold for alerting (default: 70) */
  threshold?: number;
  /** Session expiry time in ms (default: 1 hour) */
  sessionExpiryMs?: number;
  /** Risk decay rate per minute (default: 1) */
  decayPerMinute?: number;
}

export interface RiskFactor {
  name: string;
  score: number;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface SessionRiskProfile {
  sessionKey: string;
  agentId?: string;
  totalScore: number;
  factors: RiskFactor[];
  createdAt: number;
  lastActivityAt: number;
  alertedAt: number | null;
}

export interface SessionRiskSummary {
  sessionKey: string;
  agentId?: string;
  score: number;
  factorCount: number;
  topFactors: string[];
  isHighRisk: boolean;
}

// -----------------------------------------------------------------------------
// Risk Factor Definitions
// -----------------------------------------------------------------------------

export const RISK_FACTORS = {
  // Tool-related risks
  BASH_EXECUTION: { name: "bash_execution", baseScore: 5 },
  SENSITIVE_FILE_ACCESS: { name: "sensitive_file_access", baseScore: 15 },
  NETWORK_COMMAND: { name: "network_command", baseScore: 10 },
  PRIVILEGE_COMMAND: { name: "privilege_command", baseScore: 25 },
  CREDENTIAL_FILE_ACCESS: { name: "credential_file_access", baseScore: 20 },

  // Pattern-related risks
  RAPID_TOOL_CALLS: { name: "rapid_tool_calls", baseScore: 10 },
  FILE_ENUMERATION: { name: "file_enumeration", baseScore: 15 },
  ABUSE_PATTERN_MATCH: { name: "abuse_pattern_match", baseScore: 30 },

  // Anomaly-related risks
  STATISTICAL_ANOMALY: { name: "statistical_anomaly", baseScore: 20 },
  CREDENTIAL_ACCESS_SPIKE: { name: "credential_access_spike", baseScore: 25 },

  // Auth-related risks
  AUTH_FAILURE: { name: "auth_failure", baseScore: 5 },
  RATE_LIMITED: { name: "rate_limited", baseScore: 15 },

  // Content-related risks
  INJECTION_ATTEMPT: { name: "injection_attempt", baseScore: 20 },
  SUSPICIOUS_INPUT: { name: "suspicious_input", baseScore: 10 },
} as const;

export type RiskFactorName = keyof typeof RISK_FACTORS;

// -----------------------------------------------------------------------------
// Session Risk Monitor
// -----------------------------------------------------------------------------

/** Critical score multiplier: sessions exceeding threshold*CRITICAL_MULTIPLIER are auto-isolated */
const CRITICAL_MULTIPLIER = 1.5;

export class SessionRiskMonitor {
  private config: Required<SessionMonitoringConfig>;
  private sessions = new Map<string, SessionRiskProfile>();
  private lastDecayRun = Date.now();
  /** sessionKeys of sessions that have been isolated and should have tool dispatch blocked */
  private isolatedSessions = new Set<string>();

  constructor(config?: SessionMonitoringConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      threshold: config?.threshold ?? 70,
      sessionExpiryMs: config?.sessionExpiryMs ?? 60 * 60 * 1000, // 1 hour
      decayPerMinute: config?.decayPerMinute ?? 1,
    };
  }

  /**
   * Check if monitoring is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Add a risk factor to a session.
   */
  addRiskFactor(
    sessionKey: string,
    factor: string,
    options?: {
      score?: number;
      agentId?: string;
      details?: Record<string, unknown>;
    },
  ): SessionRiskProfile {
    if (!this.config.enabled) {
      return this.getOrCreateSession(sessionKey, options?.agentId);
    }

    const now = Date.now();

    // Run decay periodically
    this.maybeRunDecay(now);

    // Get or create session
    const session = this.getOrCreateSession(sessionKey, options?.agentId);
    session.lastActivityAt = now;

    // Get base score
    const factorDef = RISK_FACTORS[factor as RiskFactorName];
    const baseScore = factorDef?.baseScore ?? 10;
    const score = options?.score ?? baseScore;

    // Add factor - use the lowercase name from factorDef if it exists
    const riskFactor: RiskFactor = {
      name: factorDef?.name ?? factor,
      score,
      timestamp: now,
      details: options?.details,
    };
    session.factors.push(riskFactor);
    session.totalScore += score;

    log.debug("added risk factor", {
      sessionKey,
      factor: riskFactor.name,
      score,
      totalScore: session.totalScore,
    });

    // Check threshold — warn alert fires once; critical auto-isolates independently
    const criticalThreshold = this.config.threshold * CRITICAL_MULTIPLIER;
    if (session.totalScore >= this.config.threshold && !session.alertedAt) {
      this.emitHighRiskAlert(session);
      session.alertedAt = now;
    } else if (
      session.totalScore >= criticalThreshold &&
      !this.isolatedSessions.has(session.sessionKey)
    ) {
      // Score crossed critical after the initial warn alert was already sent
      this.isolateSession(session.sessionKey);
    }

    return session;
  }

  /**
   * Get session risk profile.
   */
  getSession(sessionKey: string): SessionRiskProfile | null {
    return this.sessions.get(sessionKey) ?? null;
  }

  /**
   * Get all high-risk sessions.
   */
  getHighRiskSessions(): SessionRiskSummary[] {
    const highRisk: SessionRiskSummary[] = [];

    for (const [_key, session] of this.sessions) {
      if (session.totalScore >= this.config.threshold) {
        highRisk.push(this.toSummary(session));
      }
    }

    // Sort by score descending
    highRisk.sort((a, b) => b.score - a.score);

    return highRisk;
  }

  /**
   * Get all sessions above a given threshold.
   */
  getSessionsAboveThreshold(threshold: number): SessionRiskSummary[] {
    const results: SessionRiskSummary[] = [];

    for (const [_, session] of this.sessions) {
      if (session.totalScore >= threshold) {
        results.push(this.toSummary(session));
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Get risk summary for a session.
   */
  getSessionSummary(sessionKey: string): SessionRiskSummary | null {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return null;
    }
    return this.toSummary(session);
  }

  /**
   * Clear a session's risk profile and release any isolation.
   */
  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.isolatedSessions.delete(sessionKey);
  }

  /**
   * Clear all sessions and release all isolation.
   */
  clearAllSessions(): void {
    this.sessions.clear();
    this.isolatedSessions.clear();
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    highRiskCount: number;
    averageScore: number;
    maxScore: number;
  } {
    let totalScore = 0;
    let maxScore = 0;
    let highRiskCount = 0;

    for (const session of this.sessions.values()) {
      totalScore += session.totalScore;
      if (session.totalScore > maxScore) {
        maxScore = session.totalScore;
      }
      if (session.totalScore >= this.config.threshold) {
        highRiskCount++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      highRiskCount,
      averageScore: this.sessions.size > 0 ? totalScore / this.sessions.size : 0,
      maxScore,
    };
  }

  /**
   * Update config at runtime.
   */
  updateConfig(config: Partial<SessionMonitoringConfig>): void {
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
    if (config.threshold !== undefined) {
      this.config.threshold = config.threshold;
    }
    if (config.sessionExpiryMs !== undefined) {
      this.config.sessionExpiryMs = config.sessionExpiryMs;
    }
    if (config.decayPerMinute !== undefined) {
      this.config.decayPerMinute = config.decayPerMinute;
    }
  }

  /**
   * Manually trigger decay (for testing).
   */
  runDecay(): void {
    this.applyDecay(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getOrCreateSession(sessionKey: string, agentId?: string): SessionRiskProfile {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      const now = Date.now();
      session = {
        sessionKey,
        agentId,
        totalScore: 0,
        factors: [],
        createdAt: now,
        lastActivityAt: now,
        alertedAt: null,
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private toSummary(session: SessionRiskProfile): SessionRiskSummary {
    // Get top factors by score
    const sortedFactors = [...session.factors].toSorted((a, b) => b.score - a.score);
    const topFactors = sortedFactors.slice(0, 3).map((f) => f.name);

    return {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      score: session.totalScore,
      factorCount: session.factors.length,
      topFactors,
      isHighRisk: session.totalScore >= this.config.threshold,
    };
  }

  private maybeRunDecay(now: number): void {
    const elapsed = now - this.lastDecayRun;
    const minutesElapsed = elapsed / 60_000;

    if (minutesElapsed >= 1) {
      this.applyDecay(now);
      this.lastDecayRun = now;
    }
  }

  private applyDecay(now: number): void {
    const expiryCutoff = now - this.config.sessionExpiryMs;

    for (const [key, session] of this.sessions) {
      // Remove expired sessions
      if (session.lastActivityAt < expiryCutoff) {
        this.sessions.delete(key);
        continue;
      }

      // Apply score decay
      const minutesSinceActivity = (now - session.lastActivityAt) / 60_000;
      const decay = Math.floor(minutesSinceActivity * this.config.decayPerMinute);

      if (decay > 0) {
        session.totalScore = Math.max(0, session.totalScore - decay);

        // If score dropped below threshold, allow re-alerting
        if (session.totalScore < this.config.threshold) {
          session.alertedAt = null;
        }
      }
    }
  }

  /**
   * Isolate a session, blocking further tool dispatch for it.
   * Also emits a security event when the session is newly isolated.
   */
  isolateSession(sessionKey: string): void {
    if (this.isolatedSessions.has(sessionKey)) {
      return; // already isolated
    }
    this.isolatedSessions.add(sessionKey);
    const session = this.sessions.get(sessionKey);

    log.warn("session isolated", {
      sessionKey,
      agentId: session?.agentId,
      score: session?.totalScore,
    });

    emitSecurityEvent({
      type: "session_anomaly",
      severity: "critical",
      source: "session-monitoring",
      message: `Session isolated due to critical risk: ${sessionKey}`,
      sessionKey,
      agentId: session?.agentId,
      details: {
        score: session?.totalScore ?? 0,
        factorCount: session?.factors.length ?? 0,
      },
      remediation: "Investigate session activity; use releaseSession() to restore after review",
    });
  }

  /**
   * Release an isolated session (e.g. after manual review).
   */
  releaseSession(sessionKey: string): void {
    this.isolatedSessions.delete(sessionKey);
  }

  /**
   * Check whether a session is currently isolated.
   */
  isSessionIsolated(sessionKey: string): boolean {
    return this.isolatedSessions.has(sessionKey);
  }

  private emitHighRiskAlert(session: SessionRiskProfile): void {
    const summary = this.toSummary(session);
    const isCritical = session.totalScore >= this.config.threshold * CRITICAL_MULTIPLIER;

    log.warn("high-risk session detected", {
      sessionKey: session.sessionKey,
      score: session.totalScore,
      threshold: this.config.threshold,
      topFactors: summary.topFactors,
      isolated: isCritical,
    });

    emitSecurityEvent({
      type: "session_anomaly",
      severity: isCritical ? "critical" : "warn",
      source: "session-monitoring",
      message: `High-risk session detected: score ${session.totalScore} (threshold: ${this.config.threshold})`,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      details: {
        score: session.totalScore,
        threshold: this.config.threshold,
        factorCount: session.factors.length,
        topFactors: summary.topFactors,
        recentFactors: session.factors.slice(-5).map((f) => ({
          name: f.name,
          score: f.score,
        })),
      },
      remediation: "Review session activity for malicious behavior",
    });

    // Auto-isolate at critical threshold
    if (isCritical) {
      this.isolateSession(session.sessionKey);
    }
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

let defaultMonitor: SessionRiskMonitor | undefined;

/**
 * Get or create the default SessionRiskMonitor instance.
 */
export function getSessionRiskMonitor(config?: SessionMonitoringConfig): SessionRiskMonitor {
  if (!defaultMonitor) {
    defaultMonitor = new SessionRiskMonitor(config);
  }
  return defaultMonitor;
}

/**
 * Reset the default monitor (for testing).
 */
export function resetSessionRiskMonitor(): void {
  defaultMonitor = undefined;
}

/**
 * Add a risk factor using the default monitor.
 */
export function addSessionRiskFactor(
  sessionKey: string,
  factor: string,
  options?: {
    score?: number;
    agentId?: string;
    details?: Record<string, unknown>;
  },
): SessionRiskProfile {
  return getSessionRiskMonitor().addRiskFactor(sessionKey, factor, options);
}

/**
 * Get high-risk sessions using the default monitor.
 */
export function getHighRiskSessions(): SessionRiskSummary[] {
  return getSessionRiskMonitor().getHighRiskSessions();
}

/**
 * Isolate a session using the default monitor, blocking tool dispatch.
 */
export function isolateSession(sessionKey: string): void {
  getSessionRiskMonitor().isolateSession(sessionKey);
}

/**
 * Release an isolated session using the default monitor.
 */
export function releaseSession(sessionKey: string): void {
  getSessionRiskMonitor().releaseSession(sessionKey);
}

/**
 * Check whether a session is currently isolated using the default monitor.
 */
export function isSessionIsolated(sessionKey: string): boolean {
  return getSessionRiskMonitor().isSessionIsolated(sessionKey);
}
