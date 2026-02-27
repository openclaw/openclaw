/**
 * Tool Monitoring - Phase 6 Security Monitoring & Detection
 *
 * Pattern-based tool abuse detection with sequence analysis.
 * Lightweight inline check with no external dependencies.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitSecurityEvent } from "./security-events.js";

const log = createSubsystemLogger("security/tool-monitoring");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ToolMonitoringConfig {
  /** Whether tool monitoring is enabled (default: true) */
  enabled?: boolean;
  /** Time window for pattern detection in ms (default: 5 minutes) */
  windowMs?: number;
  /** Maximum tool calls per window before flagging (default: 100) */
  maxCallsPerWindow?: number;
  /** Enabled abuse patterns (default: all enabled) */
  enabledPatterns?: string[];
}

export interface ToolCall {
  tool: string;
  timestamp: number;
  sessionKey?: string;
  agentId?: string;
  args?: Record<string, unknown>;
  success?: boolean;
}

export interface AbusePattern {
  name: string;
  description: string;
  severity: "warn" | "critical";
  /** Minimum calls in sequence to trigger */
  minSequence?: number;
  /** Tools that form this pattern */
  tools?: string[];
  /** Custom detector function */
  detect?: (calls: ToolCall[], window: ToolCall[]) => PatternMatch | null;
}

export interface PatternMatch {
  pattern: string;
  description: string;
  severity: "warn" | "critical";
  evidence: {
    calls: ToolCall[];
    message: string;
  };
  remediation?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_CALLS_PER_WINDOW = 100;

// -----------------------------------------------------------------------------
// Built-in Abuse Patterns
// -----------------------------------------------------------------------------

const BUILTIN_PATTERNS: AbusePattern[] = [
  {
    name: "rapid_bash_execution",
    description: "Rapid sequential bash command execution",
    severity: "warn",
    detect: (calls, window) => {
      const bashCalls = window.filter((c) => c.tool === "bash" || c.tool === "execute");
      if (bashCalls.length < 20) {
        return null;
      }

      // Check if calls are suspiciously rapid (< 1 second apart on average)
      if (bashCalls.length >= 2) {
        const durations: number[] = [];
        for (let i = 1; i < bashCalls.length; i++) {
          durations.push(bashCalls[i].timestamp - bashCalls[i - 1].timestamp);
        }
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

        if (avgDuration < 1000 && bashCalls.length >= 20) {
          return {
            pattern: "rapid_bash_execution",
            description: "Unusually rapid bash command execution detected",
            severity: "warn",
            evidence: {
              calls: bashCalls.slice(-10),
              message: `${bashCalls.length} bash commands in ${Math.round(avgDuration)}ms average interval`,
            },
            remediation: "Review bash commands for automated attack patterns",
          };
        }
      }
      return null;
    },
  },
  {
    name: "file_enumeration",
    description: "Systematic file system enumeration",
    severity: "warn",
    detect: (calls, window) => {
      // Look for patterns of read/glob/grep hitting sensitive paths
      const fsCalls = window.filter(
        (c) =>
          c.tool === "read" ||
          c.tool === "glob" ||
          c.tool === "grep" ||
          c.tool === "fs_read" ||
          c.tool === "fs_list",
      );

      if (fsCalls.length < 10) {
        return null;
      }

      // Check for sensitive path patterns
      const sensitivePatterns = [
        /\.env/i,
        /\.ssh/i,
        /\.aws/i,
        /credentials/i,
        /secrets/i,
        /\.gnupg/i,
        /\.config/i,
        /\/etc\/passwd/i,
        /\/etc\/shadow/i,
        /\.npmrc/i,
        /\.pypirc/i,
      ];

      const sensitiveHits = fsCalls.filter((c) => {
        const pathArg = c.args?.path ?? c.args?.file_path ?? c.args?.pattern;
        if (typeof pathArg !== "string") {
          return false;
        }
        return sensitivePatterns.some((p) => p.test(pathArg));
      });

      if (sensitiveHits.length >= 5) {
        return {
          pattern: "file_enumeration",
          description: "Systematic enumeration of sensitive files detected",
          severity: "warn",
          evidence: {
            calls: sensitiveHits,
            message: `${sensitiveHits.length} accesses to sensitive paths`,
          },
          remediation: "Review file access patterns for data exfiltration attempt",
        };
      }
      return null;
    },
  },
  {
    name: "credential_harvesting",
    description: "Pattern consistent with credential harvesting",
    severity: "critical",
    detect: (calls, window) => {
      // Look for sequential access to multiple credential-related files
      const credentialPaths = [".env", ".npmrc", ".pypirc", "credentials", "secrets", ".aws"];

      const credentialCalls = window.filter((c) => {
        if (c.tool !== "read" && c.tool !== "fs_read") {
          return false;
        }
        const pathArg = c.args?.path ?? c.args?.file_path;
        if (typeof pathArg !== "string") {
          return false;
        }
        return credentialPaths.some((p) => pathArg.includes(p));
      });

      // If accessing 3+ different credential files, flag as harvesting
      const uniquePaths = new Set(credentialCalls.map((c) => c.args?.path ?? c.args?.file_path));

      if (uniquePaths.size >= 3) {
        return {
          pattern: "credential_harvesting",
          description: "Multiple credential file accesses detected",
          severity: "critical",
          evidence: {
            calls: credentialCalls,
            message: `Access to ${uniquePaths.size} credential-related files`,
          },
          remediation: "Immediately review session for credential theft attempt",
        };
      }
      return null;
    },
  },
  {
    name: "network_scanning",
    description: "Network reconnaissance pattern",
    severity: "warn",
    detect: (calls, window) => {
      const networkCalls = window.filter((c) => {
        if (c.tool !== "bash" && c.tool !== "execute") {
          return false;
        }
        const cmd = c.args?.command ?? c.args?.cmd;
        if (typeof cmd !== "string") {
          return false;
        }
        return (
          cmd.includes("nmap") ||
          cmd.includes("netcat") ||
          cmd.includes("nc ") ||
          cmd.includes("curl") ||
          cmd.includes("wget") ||
          cmd.includes("ping") ||
          cmd.includes("traceroute") ||
          cmd.includes("dig") ||
          cmd.includes("nslookup")
        );
      });

      // Many network reconnaissance commands in sequence
      if (networkCalls.length >= 10) {
        return {
          pattern: "network_scanning",
          description: "Network reconnaissance activity detected",
          severity: "warn",
          evidence: {
            calls: networkCalls.slice(-10),
            message: `${networkCalls.length} network-related commands executed`,
          },
          remediation: "Review for unauthorized network scanning",
        };
      }
      return null;
    },
  },
  {
    name: "privilege_escalation",
    description: "Potential privilege escalation attempt",
    severity: "critical",
    detect: (calls, window) => {
      const privEscCalls = window.filter((c) => {
        if (c.tool !== "bash" && c.tool !== "execute") {
          return false;
        }
        const cmd = c.args?.command ?? c.args?.cmd;
        if (typeof cmd !== "string") {
          return false;
        }
        return (
          cmd.includes("sudo") ||
          cmd.includes("su ") ||
          cmd.includes("chmod +s") ||
          cmd.includes("setuid") ||
          cmd.includes("chown root") ||
          cmd.includes("/etc/sudoers") ||
          cmd.includes("visudo")
        );
      });

      if (privEscCalls.length >= 3) {
        return {
          pattern: "privilege_escalation",
          description: "Potential privilege escalation attempt",
          severity: "critical",
          evidence: {
            calls: privEscCalls,
            message: `${privEscCalls.length} privilege-related commands detected`,
          },
          remediation: "Immediately investigate for unauthorized privilege escalation",
        };
      }
      return null;
    },
  },
  {
    name: "data_exfiltration",
    description: "Potential data exfiltration pattern",
    severity: "critical",
    detect: (calls, window) => {
      // Look for read followed by network send
      const readCalls = window.filter(
        (c) => c.tool === "read" || c.tool === "fs_read" || c.tool === "glob",
      );
      const networkCalls = window.filter((c) => {
        if (c.tool !== "bash" && c.tool !== "execute" && c.tool !== "web_fetch") {
          return false;
        }
        const cmd = c.args?.command ?? c.args?.cmd ?? c.args?.url;
        if (typeof cmd !== "string") {
          return false;
        }
        return (
          cmd.includes("curl") ||
          cmd.includes("wget") ||
          cmd.includes("scp") ||
          cmd.includes("rsync") ||
          cmd.includes("nc ") ||
          cmd.includes("http")
        );
      });

      // Pattern: Many reads followed by network activity
      if (readCalls.length >= 10 && networkCalls.length >= 3) {
        // Check if network calls come after read calls
        const lastRead = Math.max(...readCalls.map((c) => c.timestamp));
        const firstNetwork = Math.min(...networkCalls.map((c) => c.timestamp));

        if (firstNetwork >= lastRead - 60000) {
          // Network activity within 1 min of reads
          return {
            pattern: "data_exfiltration",
            description: "File reads followed by network activity",
            severity: "critical",
            evidence: {
              calls: [...readCalls.slice(-5), ...networkCalls],
              message: `${readCalls.length} file reads followed by ${networkCalls.length} network operations`,
            },
            remediation: "Investigate for potential data exfiltration",
          };
        }
      }
      return null;
    },
  },
];

// -----------------------------------------------------------------------------
// Tool Monitor
// -----------------------------------------------------------------------------

export interface ThrottleResult {
  throttled: boolean;
  reason?: string;
}

export class ToolMonitor {
  private config: Required<ToolMonitoringConfig>;
  private callHistory: ToolCall[] = [];
  private patterns: AbusePattern[] = [];
  private matchCache = new Map<string, number>(); // pattern -> last match timestamp
  /** agentId → timestamp of last critical pattern match (used by shouldThrottle) */
  private criticalAgentThrottles = new Map<string, number>();

  constructor(config?: ToolMonitoringConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
      maxCallsPerWindow: config?.maxCallsPerWindow ?? DEFAULT_MAX_CALLS_PER_WINDOW,
      enabledPatterns: config?.enabledPatterns ?? BUILTIN_PATTERNS.map((p) => p.name),
    };

    // Register enabled built-in patterns
    for (const pattern of BUILTIN_PATTERNS) {
      if (this.config.enabledPatterns.includes(pattern.name)) {
        this.patterns.push(pattern);
      }
    }
  }

  /**
   * Check if monitoring is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Register a custom abuse pattern.
   */
  registerPattern(pattern: AbusePattern): void {
    this.patterns.push(pattern);
    log.debug("registered abuse pattern", { name: pattern.name });
  }

  /**
   * Record a tool call and check for abuse patterns.
   */
  record(call: ToolCall): PatternMatch[] {
    if (!this.config.enabled) {
      return [];
    }

    const now = Date.now();
    const callWithTimestamp = { ...call, timestamp: call.timestamp ?? now };

    // Add to history
    this.callHistory.push(callWithTimestamp);

    // Prune old call-history entries.
    const cutoff = now - this.config.windowMs;
    this.callHistory = this.callHistory.filter((c) => c.timestamp > cutoff);

    // GC expired agent throttle entries so the map doesn't grow unboundedly
    // when many distinct agentIds pass through and never call shouldThrottle (P-H1).
    if (this.criticalAgentThrottles.size > 0) {
      for (const [agentId, ts] of this.criticalAgentThrottles) {
        if (now - ts >= this.config.windowMs) {
          this.criticalAgentThrottles.delete(agentId);
        }
      }
    }

    // Check volume
    if (this.callHistory.length > this.config.maxCallsPerWindow) {
      this.emitVolumeAlert();
    }

    // Check patterns
    const matches: PatternMatch[] = [];
    for (const pattern of this.patterns) {
      // Skip if pattern matched recently (dedup)
      const lastMatch = this.matchCache.get(pattern.name);
      if (lastMatch && now - lastMatch < this.config.windowMs / 2) {
        continue;
      }

      if (pattern.detect) {
        const match = pattern.detect([callWithTimestamp], this.callHistory);
        if (match) {
          matches.push(match);
          this.matchCache.set(pattern.name, now);
          this.emitPatternAlert(match);
          // Record critical matches per agent for shouldThrottle gate
          if (match.severity === "critical" && callWithTimestamp.agentId) {
            this.criticalAgentThrottles.set(callWithTimestamp.agentId, now);
          }
        }
      }
    }

    return matches;
  }

  /**
   * Check whether the given agent should be throttled due to a recent critical
   * abuse pattern match. Returns `{ throttled: true }` if a critical pattern
   * fired within the current monitoring window for this agentId.
   *
   * Expired entries are pruned on access so the map doesn't grow unbounded.
   */
  shouldThrottle(agentId: string): ThrottleResult {
    const lastCritical = this.criticalAgentThrottles.get(agentId);
    if (lastCritical === undefined) {
      return { throttled: false };
    }
    const now = Date.now();
    const elapsed = now - lastCritical;
    if (elapsed < this.config.windowMs) {
      return {
        throttled: true,
        reason: `critical tool abuse pattern detected ${Math.round(elapsed / 1000)}s ago`,
      };
    }
    // Window expired — prune
    this.criticalAgentThrottles.delete(agentId);
    return { throttled: false };
  }

  /**
   * Get current window statistics.
   */
  getWindowStats(): {
    totalCalls: number;
    byTool: Record<string, number>;
    windowMs: number;
    oldestCall: number | null;
    newestCall: number | null;
  } {
    const byTool: Record<string, number> = {};
    for (const call of this.callHistory) {
      byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
    }

    return {
      totalCalls: this.callHistory.length,
      byTool,
      windowMs: this.config.windowMs,
      oldestCall: this.callHistory.length > 0 ? this.callHistory[0].timestamp : null,
      newestCall:
        this.callHistory.length > 0
          ? this.callHistory[this.callHistory.length - 1].timestamp
          : null,
    };
  }

  /**
   * Get call history for a session.
   */
  getSessionCalls(sessionKey: string): ToolCall[] {
    return this.callHistory.filter((c) => c.sessionKey === sessionKey);
  }

  /**
   * Clear history (for testing).
   */
  clearHistory(): void {
    this.callHistory = [];
    this.matchCache.clear();
    this.criticalAgentThrottles.clear();
  }

  /**
   * Update config at runtime.
   */
  updateConfig(config: Partial<ToolMonitoringConfig>): void {
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
    if (config.windowMs !== undefined) {
      this.config.windowMs = config.windowMs;
    }
    if (config.maxCallsPerWindow !== undefined) {
      this.config.maxCallsPerWindow = config.maxCallsPerWindow;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitVolumeAlert(): void {
    emitSecurityEvent({
      type: "tool_abuse_detected",
      severity: "warn",
      source: "tool-monitoring",
      message: `High tool call volume: ${this.callHistory.length} calls in ${this.config.windowMs / 1000}s`,
      details: {
        callCount: this.callHistory.length,
        windowMs: this.config.windowMs,
        threshold: this.config.maxCallsPerWindow,
      },
      remediation: "Review tool usage patterns for automated abuse",
    });
  }

  private emitPatternAlert(match: PatternMatch): void {
    log.warn("abuse pattern detected", {
      pattern: match.pattern,
      severity: match.severity,
    });

    emitSecurityEvent({
      type: "tool_abuse_detected",
      severity: match.severity,
      source: "tool-monitoring",
      message: match.description,
      details: {
        pattern: match.pattern,
        evidenceCount: match.evidence.calls.length,
        evidenceMessage: match.evidence.message,
      },
      remediation: match.remediation,
    });
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

let defaultMonitor: ToolMonitor | undefined;

/**
 * Get or create the default ToolMonitor instance.
 *
 * **Config is only accepted on the first call.** Subsequent calls with a
 * `config` argument will log a warning and return the already-initialised
 * singleton unchanged. Configure this singleton exactly once, at application
 * startup, before any other subsystem calls it.
 */
export function getToolMonitor(config?: ToolMonitoringConfig): ToolMonitor {
  if (!defaultMonitor) {
    defaultMonitor = new ToolMonitor(config);
  } else if (config !== undefined) {
    log.warn(
      "getToolMonitor() called again with config — singleton already initialized; config ignored",
    );
  }
  return defaultMonitor;
}

/**
 * Reset the default monitor (for testing).
 */
export function resetToolMonitor(): void {
  defaultMonitor = undefined;
}

/**
 * Record a tool call using the default monitor.
 */
export function recordToolCall(call: ToolCall): PatternMatch[] {
  return getToolMonitor().record(call);
}

/**
 * Check whether the given agent is currently throttled due to a critical
 * abuse pattern match using the default monitor.
 */
export function shouldThrottle(agentId: string): ThrottleResult {
  return getToolMonitor().shouldThrottle(agentId);
}
