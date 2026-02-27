/**
 * Security Monitor Runner - Phase 6 Security Monitoring & Detection
 *
 * Scheduled scan runner with lifecycle management.
 * Runs periodic security scans and emits events for findings.
 */

import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  emitSecurityEvent,
  getSecurityEventsManager,
  type SecurityEventEmitParams,
} from "./security-events.js";

const log = createSubsystemLogger("security/monitor-runner");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MonitorRunnerConfig {
  /** Whether the monitor is enabled (default: true) */
  enabled?: boolean;
  /** Scan interval (e.g., "6h", "1d") - default: "6h" */
  every?: string;
  /** Run scan on startup (default: true) */
  runOnStart?: boolean;
  /** Startup delay in ms before first scan (default: 30000) */
  startupDelayMs?: number;
  /** Deep audit interval (e.g., "24h") - runs more comprehensive checks */
  deepAuditEvery?: string;
}

export interface MonitorRunnerStatus {
  running: boolean;
  enabled: boolean;
  lastScanAt: number | null;
  lastScanDurationMs: number | null;
  lastScanFindings: number;
  nextScanAt: number | null;
  scanCount: number;
  errorCount: number;
}

export interface ScanResult {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  findings: ScanFinding[];
  errors: string[];
}

export interface ScanFinding {
  type: string;
  severity: "info" | "warn" | "critical";
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
}

export type ScanModule = {
  name: string;
  scan: () => Promise<ScanFinding[]>;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_INTERVAL = "6h";
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_DEEP_AUDIT_INTERVAL = "24h";

// -----------------------------------------------------------------------------
// Monitor Runner
// -----------------------------------------------------------------------------

export class MonitorRunner {
  private config: Required<MonitorRunnerConfig>;
  private status: MonitorRunnerStatus = {
    running: false,
    enabled: false,
    lastScanAt: null,
    lastScanDurationMs: null,
    lastScanFindings: 0,
    nextScanAt: null,
    scanCount: 0,
    errorCount: 0,
  };

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startupTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private deepAuditIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastDeepAuditAt: number | null = null;

  private scanModules: ScanModule[] = [];
  private deepScanModules: ScanModule[] = [];
  private isScanning = false;

  constructor(config?: MonitorRunnerConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      every: config?.every ?? DEFAULT_INTERVAL,
      runOnStart: config?.runOnStart ?? true,
      startupDelayMs: config?.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS,
      deepAuditEvery: config?.deepAuditEvery ?? DEFAULT_DEEP_AUDIT_INTERVAL,
    };
    this.status.enabled = this.config.enabled;
  }

  /**
   * Register a scan module to run on each scan.
   */
  registerModule(module: ScanModule): void {
    this.scanModules.push(module);
    log.debug("registered scan module", { name: module.name });
  }

  /**
   * Register a deep scan module (runs less frequently).
   */
  registerDeepModule(module: ScanModule): void {
    this.deepScanModules.push(module);
    log.debug("registered deep scan module", { name: module.name });
  }

  /**
   * Start the monitor runner.
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("monitor runner disabled by config");
      return;
    }

    if (this.status.running) {
      log.warn("monitor runner already running");
      return;
    }

    this.status.running = true;

    // Calculate interval
    const intervalMs = parseDurationMs(this.config.every, { defaultUnit: "h" });
    const deepIntervalMs = parseDurationMs(this.config.deepAuditEvery, { defaultUnit: "h" });

    // Schedule regular scans
    this.intervalHandle = setInterval(() => {
      this.runScan().catch((error) => {
        log.error("scheduled scan failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);

    // Schedule deep audits
    this.deepAuditIntervalHandle = setInterval(() => {
      this.runDeepScan().catch((error) => {
        log.error("scheduled deep scan failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, deepIntervalMs);

    // Run on start if configured
    if (this.config.runOnStart) {
      this.startupTimeoutHandle = setTimeout(() => {
        this.runScan().catch((error) => {
          log.error("startup scan failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.config.startupDelayMs);
    }

    this.status.nextScanAt =
      Date.now() + (this.config.runOnStart ? this.config.startupDelayMs : intervalMs);

    log.info("monitor runner started", {
      interval: this.config.every,
      intervalMs,
      runOnStart: this.config.runOnStart,
      moduleCount: this.scanModules.length,
      deepModuleCount: this.deepScanModules.length,
    });
  }

  /**
   * Stop the monitor runner.
   */
  stop(): void {
    if (!this.status.running) {
      return;
    }

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.deepAuditIntervalHandle) {
      clearInterval(this.deepAuditIntervalHandle);
      this.deepAuditIntervalHandle = null;
    }

    if (this.startupTimeoutHandle) {
      clearTimeout(this.startupTimeoutHandle);
      this.startupTimeoutHandle = null;
    }

    this.status.running = false;
    this.status.nextScanAt = null;

    log.info("monitor runner stopped");
  }

  /**
   * Run a scan immediately.
   */
  async runScan(deep = false): Promise<ScanResult> {
    if (this.isScanning) {
      log.warn("scan already in progress, skipping");
      return {
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        findings: [],
        errors: ["Scan already in progress"],
      };
    }

    this.isScanning = true;
    const startedAt = Date.now();
    const findings: ScanFinding[] = [];
    const errors: string[] = [];

    const modules = deep ? [...this.scanModules, ...this.deepScanModules] : this.scanModules;

    log.info("starting security scan", {
      deep,
      moduleCount: modules.length,
    });

    try {
      // Initialize events manager
      await getSecurityEventsManager().init();

      // Run each module
      for (const module of modules) {
        try {
          const moduleFindings = await module.scan();
          findings.push(...moduleFindings);

          log.debug("module scan completed", {
            module: module.name,
            findingCount: moduleFindings.length,
          });
        } catch (error) {
          const errorMsg = `Module ${module.name} failed: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);

          log.error("module scan failed", {
            module: module.name,
            error: error instanceof Error ? error.message : String(error),
          });

          // Emit monitor failure event
          emitSecurityEvent({
            type: "monitor_failure",
            severity: "warn",
            source: "monitor-runner",
            message: `Scan module ${module.name} failed`,
            details: {
              module: module.name,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      // Emit events for findings
      for (const finding of findings) {
        const eventType = this.mapFindingToEventType(finding);
        if (eventType) {
          emitSecurityEvent({
            type: eventType,
            severity: finding.severity,
            source: "monitor-runner",
            message: finding.message,
            details: finding.details,
            remediation: finding.remediation,
          });
        }
      }

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;

      // Update status
      this.status.lastScanAt = startedAt;
      this.status.lastScanDurationMs = durationMs;
      this.status.lastScanFindings = findings.length;
      this.status.scanCount++;

      if (errors.length > 0) {
        this.status.errorCount++;
      }

      // Calculate next scan time
      if (this.status.running) {
        const intervalMs = parseDurationMs(this.config.every, { defaultUnit: "h" });
        this.status.nextScanAt = completedAt + intervalMs;
      }

      if (deep) {
        this.lastDeepAuditAt = completedAt;
      }

      log.info("security scan completed", {
        deep,
        durationMs,
        findingCount: findings.length,
        errorCount: errors.length,
      });

      return {
        startedAt,
        completedAt,
        durationMs,
        findings,
        errors,
      };
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Run a deep scan (includes deep modules).
   */
  async runDeepScan(): Promise<ScanResult> {
    return this.runScan(true);
  }

  /**
   * Get current runner status.
   */
  getStatus(): MonitorRunnerStatus {
    return { ...this.status };
  }

  /**
   * Check if currently scanning.
   */
  isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  /**
   * Get last deep audit timestamp.
   */
  getLastDeepAuditAt(): number | null {
    return this.lastDeepAuditAt;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mapFindingToEventType(finding: ScanFinding): SecurityEventEmitParams["type"] | null {
    // Map finding types to security event types
    const typeMap: Record<string, SecurityEventEmitParams["type"]> = {
      skill_scan: "skill_scan_failed",
      container_escape: "container_escape_attempt",
      credential_audit: "credential_audit_integrity_failed",
      credential_rotation: "credential_rotation_due",
      injection: "injection_detected",
      security_audit_critical: "security_audit_critical",
      security_audit_warning: "security_audit_warning",
      env_credential: "env_credential_exposed",
    };

    return typeMap[finding.type] ?? null;
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

let defaultRunner: MonitorRunner | undefined;

/**
 * Get or create the default MonitorRunner instance.
 *
 * **Config is only accepted on the first call.** Subsequent calls with a
 * `config` argument will log a warning and return the already-initialised
 * singleton unchanged. Configure this singleton exactly once, at application
 * startup, before any other subsystem calls it.
 */
export function getMonitorRunner(config?: MonitorRunnerConfig): MonitorRunner {
  if (!defaultRunner) {
    defaultRunner = new MonitorRunner(config);
  } else if (config !== undefined) {
    log.warn(
      "getMonitorRunner() called again with config — singleton already initialized; config ignored",
    );
  }
  return defaultRunner;
}

/**
 * Reset the default runner (for testing).
 */
export function resetMonitorRunner(): void {
  if (defaultRunner) {
    defaultRunner.stop();
  }
  defaultRunner = undefined;
}

// -----------------------------------------------------------------------------
// Built-in Scan Modules
// -----------------------------------------------------------------------------

/**
 * Create a scan module that checks credential audit integrity.
 */
export function createCredentialAuditScanModule(): ScanModule {
  return {
    name: "credential-audit-integrity",
    scan: async () => {
      const findings: ScanFinding[] = [];

      try {
        // Dynamic import to avoid circular dependencies
        const { verifyAuditLogIntegrity } = await import("./credential-audit.js");
        const result = verifyAuditLogIntegrity();

        if (!result.valid) {
          findings.push({
            type: "credential_audit",
            severity: "critical",
            message: `Credential audit log integrity check failed: ${result.reason}`,
            details: {
              brokenAt: result.brokenAt,
              entryIndex: result.entryIndex,
            },
            remediation: "Investigate the audit log for tampering or corruption",
          });
        }
      } catch (error) {
        findings.push({
          type: "credential_audit",
          severity: "warn",
          message: `Failed to verify credential audit integrity: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      return findings;
    },
  };
}

/**
 * Create a scan module that checks for credentials due for rotation.
 */
export function createCredentialRotationScanModule(): ScanModule {
  return {
    name: "credential-rotation-check",
    scan: async () => {
      const findings: ScanFinding[] = [];

      try {
        const { getCredentialsDueForRotation } = await import("./credential-vault.js");
        const dueCredentials = getCredentialsDueForRotation();

        for (const cred of dueCredentials) {
          findings.push({
            type: "credential_rotation",
            severity: "info",
            message: `Credential ${cred.name} (${cred.scope}) is due for rotation`,
            details: {
              name: cred.name,
              scope: cred.scope,
              lastRotated: cred.rotatedAt,
              daysSinceRotation: cred.rotatedAt
                ? Math.floor((Date.now() - cred.rotatedAt) / (24 * 60 * 60 * 1000))
                : null,
            },
            remediation: "Rotate this credential using: openclaw security credentials rotate",
          });
        }
      } catch (error) {
        // Vault may not be initialized - that's OK
        log.debug("credential rotation check skipped", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      return findings;
    },
  };
}

/**
 * Create a scan module that runs the full security audit.
 * Note: This module requires a config object to be passed at runtime.
 */
export function createSecurityAuditScanModule(
  getConfig: () => Promise<OpenClawConfig>,
): ScanModule {
  return {
    name: "security-audit",
    scan: async () => {
      const findings: ScanFinding[] = [];

      try {
        const { runSecurityAudit } = await import("./audit.js");
        const config = await getConfig();
        const result = await runSecurityAudit({
          config,
          deep: false,
        });

        for (const finding of result.findings) {
          // SecurityAuditFinding has severity: "info" | "warn" | "critical"
          const severity = finding.severity;

          findings.push({
            type: severity === "critical" ? "security_audit_critical" : "security_audit_warning",
            severity,
            message: finding.title,
            details: {
              checkId: finding.checkId,
              detail: finding.detail,
            },
            remediation: finding.remediation,
          });
        }
      } catch (error) {
        findings.push({
          type: "security_audit_warning",
          severity: "warn",
          message: `Security audit failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      return findings;
    },
  };
}

/**
 * Create a scan module that checks for exposed env credentials.
 */
export function createEnvCredentialScanModule(): ScanModule {
  return {
    name: "env-credential-scan",
    scan: async () => {
      const findings: ScanFinding[] = [];

      try {
        const { scanEnvironmentForCredentials } = await import("./credential-env-scan.js");
        const result = scanEnvironmentForCredentials();

        for (const cred of result.findings) {
          findings.push({
            type: "env_credential",
            severity: cred.riskLevel === "high" ? "warn" : "info",
            message: `Exposed credential in environment: ${cred.provider}`,
            details: {
              provider: cred.provider,
              varName: cred.varName,
              riskLevel: cred.riskLevel,
              recommendation: cred.recommendation,
            },
            remediation: "Migrate credential to vault: openclaw security credentials migrate --env",
          });
        }
      } catch (error) {
        log.debug("env credential scan skipped", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      return findings;
    },
  };
}

/**
 * Register all built-in scan modules with the runner.
 * @param runner The monitor runner to register modules with
 * @param getConfig Optional function to get the config for security audit
 */
export function registerBuiltinModules(
  runner: MonitorRunner,
  getConfig?: () => Promise<OpenClawConfig>,
): void {
  runner.registerModule(createCredentialAuditScanModule());
  runner.registerModule(createCredentialRotationScanModule());
  runner.registerModule(createEnvCredentialScanModule());

  // Security audit is deeper/slower, so it's a deep module
  // Only register if config getter is provided
  if (getConfig) {
    runner.registerDeepModule(createSecurityAuditScanModule(getConfig));
  }
}
