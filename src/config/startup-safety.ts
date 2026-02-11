/**
 * Startup Safety Integration for OpenClaw
 * 
 * Handles safe mode detection, crash recovery, and startup validation
 * to ensure OpenClaw can always start in a recoverable state.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./paths.js";
import { resolveRequiredHomeDir } from "../infra/dotenv.js";
import type { OpenClawConfig } from "./types.js";
import { 
  shouldStartInSafeMode,
  createSafeModeConfig,
  applySafeModeRestrictions,
  logSafeModeActivation,
  type SafeModeOptions
} from "./safe-mode.js";
import { getAtomicConfigManager, emergencyRecoverConfig } from "./atomic-config.js";
import { loadConfig, writeConfigFile } from "./io.js";

export type StartupSafetyOptions = {
  /** Maximum number of consecutive startup failures before forcing safe mode */
  maxStartupFailures?: number;
  /** Time window for counting startup failures (ms) */
  failureWindowMs?: number;
  /** Whether to automatically recover from startup failures */
  autoRecover?: boolean;
  /** Logger for startup safety messages */
  logger?: Pick<typeof console, "info" | "warn" | "error" | "debug">;
};

export type StartupFailureRecord = {
  timestamp: number;
  reason: string;
  pid: number;
  version?: string;
};

export type StartupSafetyResult = {
  /** Whether safe mode should be activated */
  useSafeMode: boolean;
  /** The configuration to use (may be safe mode config or recovered config) */
  config: OpenClawConfig;
  /** Reason for the startup decision */
  reason: string;
  /** Whether emergency recovery was performed */
  emergencyRecovered?: boolean;
  /** Whether a backup was restored */
  backupRestored?: string;
};

const DEFAULT_OPTIONS: Required<StartupSafetyOptions> = {
  maxStartupFailures: 3,
  failureWindowMs: 300000, // 5 minutes
  autoRecover: true,
  logger: console,
};

export class StartupSafetyManager {
  private options: Required<StartupSafetyOptions>;
  private stateDir: string;
  private failureLogPath: string;

  constructor(options: StartupSafetyOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.stateDir = resolveStateDir(
      process.env, 
      () => resolveRequiredHomeDir(process.env, () => require("os").homedir())
    );
    this.failureLogPath = path.join(this.stateDir, "startup-failures.json");
    
    this.ensureStateDir();
  }

  private ensureStateDir(): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.options.logger.error("Failed to create state directory:", error);
    }
  }

  private async loadFailureHistory(): Promise<StartupFailureRecord[]> {
    try {
      if (!fs.existsSync(this.failureLogPath)) {
        return [];
      }
      
      const content = await fs.promises.readFile(this.failureLogPath, "utf-8");
      const failures = JSON.parse(content) as StartupFailureRecord[];
      
      // Clean up old failures outside the window
      const cutoff = Date.now() - this.options.failureWindowMs;
      return failures.filter(failure => failure.timestamp > cutoff);
    } catch (error) {
      this.options.logger.warn("Failed to load startup failure history:", error);
      return [];
    }
  }

  private async saveFailureHistory(failures: StartupFailureRecord[]): Promise<void> {
    try {
      await fs.promises.writeFile(
        this.failureLogPath, 
        JSON.stringify(failures, null, 2),
        { encoding: "utf-8", mode: 0o600 }
      );
    } catch (error) {
      this.options.logger.error("Failed to save startup failure history:", error);
    }
  }

  /**
   * Record a startup failure
   */
  async recordStartupFailure(reason: string): Promise<void> {
    try {
      const failures = await this.loadFailureHistory();
      
      failures.push({
        timestamp: Date.now(),
        reason,
        pid: process.pid,
        version: process.env.OPENCLAW_VERSION || "unknown",
      });

      await this.saveFailureHistory(failures);
      
      this.options.logger.warn(`Recorded startup failure: ${reason}`);
      this.options.logger.warn(`Total recent failures: ${failures.length}/${this.options.maxStartupFailures}`);
      
      if (failures.length >= this.options.maxStartupFailures) {
        this.options.logger.error("🚨 Maximum startup failures reached - safe mode will be activated on next restart");
      }
    } catch (error) {
      this.options.logger.error("Failed to record startup failure:", error);
    }
  }

  /**
   * Clear startup failure history (called after successful startup)
   */
  async clearStartupFailures(): Promise<void> {
    try {
      if (fs.existsSync(this.failureLogPath)) {
        await fs.promises.unlink(this.failureLogPath);
        this.options.logger.debug("Cleared startup failure history");
      }
    } catch (error) {
      this.options.logger.warn("Failed to clear startup failure history:", error);
    }
  }

  /**
   * Check if too many startup failures have occurred recently
   */
  async hasExcessiveFailures(): Promise<boolean> {
    const failures = await this.loadFailureHistory();
    return failures.length >= this.options.maxStartupFailures;
  }

  /**
   * Determine startup configuration based on safety conditions
   */
  async determineStartupConfig(): Promise<StartupSafetyResult> {
    this.options.logger.debug("Determining startup configuration...");

    // Check explicit safe mode request
    if (shouldStartInSafeMode()) {
      logSafeModeActivation(this.options.logger);
      return {
        useSafeMode: true,
        config: createSafeModeConfig(),
        reason: "Safe mode explicitly requested",
      };
    }

    // Check for excessive startup failures
    const hasFailures = await this.hasExcessiveFailures();
    if (hasFailures) {
      this.options.logger.warn("🚨 Excessive startup failures detected - activating safe mode");
      logSafeModeActivation(this.options.logger);
      
      return {
        useSafeMode: true,
        config: createSafeModeConfig(),
        reason: "Excessive startup failures detected",
      };
    }

    // Try to load normal config
    try {
      this.options.logger.debug("Attempting to load normal configuration...");
      const config = loadConfig();
      
      // Validate the loaded config
      const manager = getAtomicConfigManager();
      const validation = await manager.validateConfig(config);
      
      if (!validation.valid) {
        this.options.logger.error("Configuration validation failed:");
        validation.errors.forEach(error => 
          this.options.logger.error(`  - ${error}`)
        );

        if (this.options.autoRecover) {
          this.options.logger.info("Attempting emergency recovery...");
          
          const recoveryResult = await emergencyRecoverConfig();
          
          if (recoveryResult.success) {
            this.options.logger.info("✓ Emergency recovery successful");
            
            return {
              useSafeMode: false,
              config: loadConfig(), // Reload recovered config
              reason: "Emergency recovery applied",
              emergencyRecovered: true,
              backupRestored: recoveryResult.backupId,
            };
          } else {
            this.options.logger.error("✗ Emergency recovery failed, falling back to safe mode");
            logSafeModeActivation(this.options.logger);
            
            return {
              useSafeMode: true,
              config: createSafeModeConfig(),
              reason: "Emergency recovery failed",
            };
          }
        } else {
          this.options.logger.error("Auto-recovery disabled, falling back to safe mode");
          logSafeModeActivation(this.options.logger);
          
          return {
            useSafeMode: true,
            config: createSafeModeConfig(),
            reason: "Configuration validation failed",
          };
        }
      }

      // Configuration is valid
      this.options.logger.debug("Configuration loaded and validated successfully");
      
      if (validation.warnings.length > 0) {
        this.options.logger.warn("Configuration warnings:");
        validation.warnings.forEach(warning => 
          this.options.logger.warn(`  - ${warning}`)
        );
      }

      if (validation.twelveFactorIssues.length > 0) {
        this.options.logger.warn("12-factor app principle violations:");
        validation.twelveFactorIssues.forEach(issue => 
          this.options.logger.warn(`  - ${issue}`)
        );
      }

      return {
        useSafeMode: false,
        config,
        reason: "Normal configuration loaded successfully",
      };

    } catch (error) {
      this.options.logger.error("Failed to load configuration:", error);
      await this.recordStartupFailure(`Configuration load error: ${error}`);

      if (this.options.autoRecover) {
        this.options.logger.info("Attempting emergency recovery...");
        
        try {
          const recoveryResult = await emergencyRecoverConfig();
          
          if (recoveryResult.success) {
            this.options.logger.info("✓ Emergency recovery successful");
            
            return {
              useSafeMode: false,
              config: loadConfig(), // Reload recovered config
              reason: "Emergency recovery after config load failure",
              emergencyRecovered: true,
              backupRestored: recoveryResult.backupId,
            };
          }
        } catch (recoveryError) {
          this.options.logger.error("Emergency recovery failed:", recoveryError);
        }
      }

      this.options.logger.error("Falling back to safe mode");
      logSafeModeActivation(this.options.logger);
      
      return {
        useSafeMode: true,
        config: createSafeModeConfig(),
        reason: "Configuration load failed",
      };
    }
  }

  /**
   * Install process handlers for startup failure detection
   */
  installProcessHandlers(): void {
    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      this.options.logger.error("Uncaught exception during startup:", error);
      await this.recordStartupFailure(`Uncaught exception: ${error.message}`);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason, promise) => {
      this.options.logger.error("Unhandled promise rejection during startup:", reason);
      await this.recordStartupFailure(`Unhandled rejection: ${reason}`);
      process.exit(1);
    });

    // Handle SIGTERM gracefully
    process.on("SIGTERM", async () => {
      this.options.logger.info("Received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });

    // Handle SIGINT (Ctrl+C) gracefully
    process.on("SIGINT", async () => {
      this.options.logger.info("Received SIGINT, shutting down gracefully...");
      process.exit(0);
    });
  }

  /**
   * Mark successful startup (clears failure history)
   */
  async markSuccessfulStartup(): Promise<void> {
    await this.clearStartupFailures();
    this.options.logger.debug("Marked successful startup");
  }

  /**
   * Get startup failure statistics
   */
  async getFailureStats(): Promise<{
    recentFailures: number;
    maxFailures: number;
    windowMs: number;
    failures: StartupFailureRecord[];
  }> {
    const failures = await this.loadFailureHistory();
    
    return {
      recentFailures: failures.length,
      maxFailures: this.options.maxStartupFailures,
      windowMs: this.options.failureWindowMs,
      failures,
    };
  }
}

/**
 * Global startup safety manager instance
 */
let globalStartupSafetyManager: StartupSafetyManager | null = null;

export function getStartupSafetyManager(options?: StartupSafetyOptions): StartupSafetyManager {
  if (!globalStartupSafetyManager) {
    globalStartupSafetyManager = new StartupSafetyManager(options);
  }
  return globalStartupSafetyManager;
}

/**
 * Convenience function to determine startup configuration
 */
export async function determineStartupConfig(options?: StartupSafetyOptions): Promise<StartupSafetyResult> {
  const manager = getStartupSafetyManager(options);
  return await manager.determineStartupConfig();
}

/**
 * Convenience function to record startup failure
 */
export async function recordStartupFailure(reason: string, options?: StartupSafetyOptions): Promise<void> {
  const manager = getStartupSafetyManager(options);
  await manager.recordStartupFailure(reason);
}

/**
 * Convenience function to mark successful startup
 */
export async function markSuccessfulStartup(options?: StartupSafetyOptions): Promise<void> {
  const manager = getStartupSafetyManager(options);
  await manager.markSuccessfulStartup();
}